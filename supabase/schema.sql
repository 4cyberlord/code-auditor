-- AI Engineering Workbench — session storage
--
-- Run this once in the Supabase SQL editor.
--
-- Screenshots are uploaded to Supabase Storage; this schema records where each
-- one lives, locally and remotely, plus the metadata.
--
-- A screen grab can contain credentials, private source or customer data, so the
-- lifecycle is explicit: deleting a session cascades to its screenshot rows, and
-- `purged_at` records when the underlying image was destroyed. A row can outlive
-- its picture, which is what lets history stay readable after the sensitive part
-- has been deleted.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- sessions

create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  title        text        not null default 'Untitled session',
  -- Free text the user adds to describe the problem (section 7, "Add notes").
  note         text        not null default '',
  -- Extra context pasted in alongside the screenshots ("Add text context").
  context      text        not null default '',
  -- active | archived. Archive is reversible, so it is a state and not a delete.
  status       text        not null default 'active'
                 check (status in ('active', 'archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists sessions_status_updated_idx
  on sessions (status, updated_at desc);

-- ------------------------------------------------------------- screenshots

create table if not exists screenshots (
  id           uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  session_id   uuid        not null references sessions (id) on delete cascade,
  -- Explicit ordering column so screenshots can be reordered without rewriting
  -- ids; section 7 asks for reorder, and capture order is not always the order
  -- that explains the problem.
  position     integer     not null,
  -- Absolute path on the machine that took the capture. Nullable, because the
  -- local copy can be removed while the uploaded one remains.
  local_path   text,
  -- Where the upload landed. Null until it has been uploaded.
  storage_bucket text,
  storage_path   text,
  uploaded_at    timestamptz,
  -- Set when the image itself has been destroyed in both places. The row stays,
  -- so a session's history still reads correctly with the picture gone.
  purged_at      timestamptz,
  file_name    text        not null,
  bytes        integer     not null default 0,
  mime         text        not null default 'image/png',
  width        integer,
  height       integer,
  -- Which display it came from, once multi-monitor lands.
  monitor      text,
  captured_at  timestamptz not null default now(),
  unique (session_id, position) deferrable initially deferred
);

create index if not exists screenshots_session_idx
  on screenshots (session_id, position);

-- Finds images that still need uploading, and images still holding bytes when a
-- purge is asked for.
create index if not exists screenshots_pending_upload_idx
  on screenshots (session_id) where uploaded_at is null and purged_at is null;

-- -------------------------------------------------------------------- runs

create table if not exists runs (
  id           uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  session_id   uuid        not null references sessions (id) on delete cascade,
  -- auto | code | research
  mode         text        not null default 'auto',
  -- The note as it stood when the run was launched, so history shows what was
  -- actually asked rather than what the session says now.
  asked        text        not null default '',
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists runs_session_idx on runs (session_id, started_at desc);

-- --------------------------------------------------------- agent responses

create table if not exists agent_responses (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid        not null references runs (id) on delete cascade,
  provider       text        not null,
  model          text        not null,
  -- The per-launch identity the app already uses to discard stale events.
  attempt_id     text        not null,
  -- done | error | cancelled
  status         text        not null,
  -- Full streamed reply, kept verbatim.
  body           text        not null default '',
  -- Parsed FINAL block.
  final_kind     text,
  final_language text,
  final_answer   text,
  final_code     text,
  final_claims   text[]      not null default '{}',
  complexity     text,
  confidence     real,
  well_formed    boolean     not null default false,
  input_tokens   bigint,
  output_tokens  bigint,
  elapsed_ms     bigint,
  error          text,
  created_at     timestamptz not null default now()
);

create index if not exists agent_responses_run_idx on agent_responses (run_id);

-- ---------------------------------------------------------------- verdicts

create table if not exists verdicts (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid        not null references runs (id) on delete cascade,
  -- unanimous | majority | split | none | insufficient
  verdict         text        not null,
  headline        text,
  detail          text,
  -- high | mixed | low: how much the lexical comparison is worth for this run.
  reliability     text,
  -- Agreement groups, as arrays of provider ids.
  camps           jsonb       not null default '[]'::jsonb,
  outliers        text[]      not null default '{}',
  representative  text,
  judge_provider  text,
  judge_text      text,
  -- Section 63 and 67: an answer is not "verified" because a model said so.
  -- proposed | implemented | tested | verified
  state           text        not null default 'proposed'
                    check (state in ('proposed', 'implemented', 'tested', 'verified')),
  created_at      timestamptz not null default now()
);

create index if not exists verdicts_run_idx on verdicts (run_id);

-- ------------------------------------------------------------ cloud solving

create table if not exists solve_jobs (
  id                uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  session_id        uuid        not null references sessions (id) on delete cascade,
  -- council is the only v1 cloud mode. Keeping it as a column lets later builds
  -- add cheaper panel-only jobs without changing the queue shape.
  mode              text        not null default 'council'
                      check (mode in ('council')),
  status            text        not null default 'queued'
                      check (status in ('queued', 'running', 'needs_attention',
                                        'failed', 'completed', 'cancelled')),
  progress_phase    text        not null default 'queued',
  settings_snapshot jsonb       not null default '{}'::jsonb,
  error             text,
  result_summary    text        not null default '',
  created_at        timestamptz not null default now(),
  claimed_at        timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists solve_jobs_status_created_idx
  on solve_jobs (status, created_at);

create index if not exists solve_jobs_session_idx
  on solve_jobs (session_id, created_at desc);

create table if not exists solve_job_images (
  id             uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  job_id         uuid        not null references solve_jobs (id) on delete cascade,
  session_id     uuid        not null references sessions (id) on delete cascade,
  position       integer     not null,
  storage_bucket text        not null,
  storage_path   text        not null,
  file_name      text        not null,
  bytes          integer     not null default 0,
  mime           text        not null default 'image/png',
  width          integer,
  height         integer,
  captured_at    timestamptz not null default now(),
  unique (job_id, position)
);

create index if not exists solve_job_images_job_idx
  on solve_job_images (job_id, position);

create table if not exists solve_job_events (
  id         uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  job_id     uuid        not null references solve_jobs (id) on delete cascade,
  level      text        not null default 'info'
               check (level in ('info', 'warn', 'error')),
  phase      text        not null default 'queued',
  message    text        not null,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists solve_job_events_job_idx
  on solve_job_events (job_id, created_at);

create table if not exists council_reports (
  id         uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  job_id     uuid        not null unique references solve_jobs (id) on delete cascade,
  session_id uuid        not null references sessions (id) on delete cascade,
  winner     text,
  synthesis  text        not null default '',
  markdown   text        not null default '',
  report     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists council_reports_session_idx
  on council_reports (session_id, created_at desc);

create table if not exists notification_devices (
  id           uuid primary key default gen_random_uuid(),
  -- Who this belongs to. Nullable here and made mandatory by
  -- tenancy-constrain.sql, once the backfill is verified.
  owner_id     uuid,
  platform     text        not null check (platform in ('ios')),
  device_token text        not null unique,
  label        text        not null default '',
  enabled      boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- settings

create table if not exists settings (
  key        text        not null,
  -- Whose value this is. All-zeroes means a platform row: yours,
  -- readable by every account, written only on purpose.
  owner_id   uuid        not null
               default '00000000-0000-0000-0000-000000000000',
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);

-- ---------------------------------------------------------- intelligence/RAG

create table if not exists intelligence_sources (
  id          text primary key,
  title       text        not null,
  url         text        not null unique,
  trust       text        not null
                check (trust in ('official', 'academic', 'reference', 'community')),
  note        text        not null default '',
  tags        text[]      not null default '{}',
  updated_at  timestamptz not null default now()
);

create table if not exists intelligence_records (
  id               text primary key,
  title            text        not null,
  kind             text        not null
                     check (kind in ('pattern', 'problem', 'runtime', 'resource')),
  summary          text        not null,
  guidance         jsonb       not null default '[]'::jsonb,
  tags             text[]      not null default '{}',
  complexity        text,
  target_runtime_ms integer,
  target_memory_mb  integer,
  source_urls       text[]      not null default '{}',
  content_hash      text,
  updated_at        timestamptz not null default now()
);

create index if not exists intelligence_records_tags_idx
  on intelligence_records using gin (tags);

create index if not exists intelligence_sources_tags_idx
  on intelligence_sources using gin (tags);

-- ----------------------------------------------------------------- touched

-- ------------------------------------------------------------------- auth

-- The username and 4-digit PIN that unlock the app. See migrations.sql for the
-- reasoning; in short, `pin_hash` is Argon2id over a Keychain-peppered PIN, and
-- `failed_attempts` / `locked_until` are the defence that a short PIN actually
-- depends on.
create table if not exists app_users (
  id              uuid        primary key default gen_random_uuid(),
  username        text        not null,
  pin_hash        text        not null,
  failed_attempts integer     not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists app_users_username_idx
  on app_users (lower(username));

-- "Remember this Mac for 30 days": the SHA-256 of a token whose plaintext lives
-- in the Keychain, so this table on its own is not a way in.
create table if not exists app_sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references app_users (id) on delete cascade,
  token_hash   text        not null unique,
  label        text        not null default '',
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists app_sessions_user_idx
  on app_sessions (user_id, expires_at desc);

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists sessions_touch on sessions;
create trigger sessions_touch before update on sessions
  for each row execute function touch_updated_at();

drop trigger if exists settings_touch on settings;
create trigger settings_touch before update on settings
  for each row execute function touch_updated_at();

drop trigger if exists solve_jobs_touch on solve_jobs;
create trigger solve_jobs_touch before update on solve_jobs
  for each row execute function touch_updated_at();

drop trigger if exists notification_devices_touch on notification_devices;
create trigger notification_devices_touch before update on notification_devices
  for each row execute function touch_updated_at();

drop trigger if exists intelligence_sources_touch on intelligence_sources;
create trigger intelligence_sources_touch before update on intelligence_sources
  for each row execute function touch_updated_at();

drop trigger if exists intelligence_records_touch on intelligence_records;
create trigger intelligence_records_touch before update on intelligence_records
  for each row execute function touch_updated_at();

drop trigger if exists app_users_touch on app_users;
create trigger app_users_touch before update on app_users
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- app config
--
-- Everything that used to sit in `.development.env`, so the machine running this
-- app is not also the place its configuration lives. One row per variable.
--
-- Not the `settings` table, deliberately. `settings_load` is a Tauri command,
-- which means the webview can read any key in it -- fine for a pane layout,
-- catastrophic for a TokenRouter key. This table has no command that returns a
-- secret value, and that is the whole reason it is separate.
create table if not exists app_config (
  key        text        not null,
  -- Whose value this is. All-zeroes means a platform row: yours,
  -- readable by every account, written only on purpose.
  owner_id   uuid        not null
               default '00000000-0000-0000-0000-000000000000',
  value      text        not null default '',
  -- Whether the value may ever leave the machine's Rust side. Secrets are
  -- listed to the UI by name only; the value goes to outbound requests and
  -- nowhere else.
  secret     boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);

-- No policies, and that is the point.
--
-- Supabase grants the `anon` and `authenticated` roles access to tables in
-- `public`, and the anon key ships inside the app -- so a table holding a
-- GitHub token with RLS off is a table that anyone who opens the bundle can
-- read. Enabling row level security and writing no policy at all leaves exactly
-- one way in: `service_role`, which bypasses RLS and now lives in the Edge
-- Function rather than on a laptop.
alter table app_config enable row level security;

drop trigger if exists app_config_touch on app_config;
create trigger app_config_touch before update on app_config
  for each row execute function touch_updated_at();
