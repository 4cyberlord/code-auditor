-- Phase 04 sign-in functions, extracted from migrations.sql so they can be
-- pasted straight into the Supabase SQL editor.
--
-- Identical to what `ensure_schema` applies when the app launches; running it
-- here just means not having to launch the app first. Safe to run twice.

-- --------------------------------------------------------- server-side auth
--
-- Phase 04. The username and PIN stay exactly as the way in; what changes is
-- *where* they are checked.
--
-- Today the desktop reads a pepper from the Mac's Keychain, hashes the PIN with
-- Argon2id locally, and compares. That means: a Keychain entry that cannot be
-- removed, a signature prompt on every rebuild, and an app that fails closed
-- when macOS declines. It also means the attempt counter is enforced by the
-- client that is doing the guessing.
--
-- So verification moves into the database, called by the Edge Function, with the
-- pepper supplied as a function secret. bcrypt via pgcrypto rather than Argon2id
-- because it is already installed in every Supabase project — no WASM
-- dependency in the Deno runtime, and nothing new to keep working.
--
-- `security definer` so the function may read `pin_hash` while nothing else can.

create extension if not exists pgcrypto;

drop function if exists auth_verify_pin(text, text, text);

create or replace function auth_verify_pin(p_username text, p_pin text, p_pepper text)
returns table (
  user_id uuid,
  matched_username text,
  outcome text,
  locked_until timestamptz,
  attempts_remaining integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u record;
  attempts integer;
begin
  select app_users.id, app_users.username, app_users.pin_hash, app_users.failed_attempts, app_users.locked_until
    into u
    from app_users
   where lower(username) = lower(trim(p_username));

  -- Deliberately the same shape as a wrong PIN to the caller above: telling an
  -- unauthenticated client that a username exists is telling it what to guess.
  if not found then
    return query select null::uuid, null::text, 'no', null::timestamptz, null::integer;
    return;
  end if;

  if u.locked_until is not null and u.locked_until > now() then
    return query select u.id, u.username, 'locked', u.locked_until, 0;
    return;
  end if;

  -- An Argon2id hash from the old local scheme. Not a failure and not a wrong
  -- PIN: this account simply predates server-side checking and needs its PIN
  -- set once more.
  if left(u.pin_hash, 2) <> '$2' then
    return query select u.id, u.username, 'needs_reset', null::timestamptz, null::integer;
    return;
  end if;

  if crypt(p_pin || p_pepper, u.pin_hash) = u.pin_hash then
    update app_users
       set failed_attempts = 0, locked_until = null, last_login_at = now()
     where id = u.id;
    return query select u.id, u.username, 'ok', null::timestamptz, 5;
    return;
  end if;

  -- Four free tries, then widening windows. Enforced here, so it holds however
  -- the caller behaves.
  attempts := u.failed_attempts + 1;
  update app_users
     set failed_attempts = attempts,
         locked_until = case
           when attempts <= 4 then null
           when attempts = 5 then now() + interval '1 minute'
           when attempts = 6 then now() + interval '5 minutes'
           when attempts = 7 then now() + interval '15 minutes'
           when attempts = 8 then now() + interval '1 hour'
           else now() + interval '24 hours'
         end
   where id = u.id;

  return query
    select u.id,
           u.username,
           'no',
           case
             when attempts <= 4 then null::timestamptz
             when attempts = 5 then now() + interval '1 minute'
             when attempts = 6 then now() + interval '5 minutes'
             when attempts = 7 then now() + interval '15 minutes'
             when attempts = 8 then now() + interval '1 hour'
             else now() + interval '24 hours'
           end,
           greatest(0, 5 - attempts);
end;
$$;

create or replace function auth_set_pin(p_user_id uuid, p_pin text, p_pepper text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_pin !~ '^[0-9]{4}$' then
    raise exception 'The PIN has to be exactly 4 digits.';
  end if;
  update app_users
     set pin_hash = crypt(p_pin || p_pepper, gen_salt('bf', 12)),
         failed_attempts = 0,
         locked_until = null,
         updated_at = now()
   where id = p_user_id;
end;
$$;

-- Only the service role, which is to say only the Edge Function. `security
-- definer` would otherwise let any role that can reach PostgREST call these.
revoke all on function auth_verify_pin(text, text, text) from public, anon, authenticated;
revoke all on function auth_set_pin(uuid, text, text) from public, anon, authenticated;
