-- Additive service-role-only language knowledge registry.
create table if not exists public.language_runtime_packs(
 language text primary key check(language in ('python','javascript','typescript','java','c','cpp','rust','go','php','ruby','bash')),
 runtime_version text not null check(length(runtime_version) between 1 and 64),
 content_md text not null check(octet_length(content_md) between 1 and 32768),
 checksum text not null check(checksum ~ '^[a-f0-9]{64}$'),
 source_urls text[] not null default '{}',
 status text not null default 'draft' check(status in('draft','validated','retired')),
 reviewed_by text, reviewed_at timestamptz, updated_at timestamptz not null default now(),
 constraint review_before_publish check(status <> 'validated' or (reviewed_by is not null and reviewed_at is not null))
);
create table if not exists public.language_runtime_proposals(
 id uuid primary key default gen_random_uuid(), language text not null references public.language_runtime_packs(language),
 diagnostic_category text not null, proposed_markdown text not null check(octet_length(proposed_markdown) between 1 and 32768),
 evidence_digest text not null, status text not null default 'pending' check(status in('pending','accepted','rejected')),
 created_at timestamptz not null default now(), reviewed_at timestamptz
);
alter table public.language_runtime_packs enable row level security;
alter table public.language_runtime_proposals enable row level security;
revoke all on public.language_runtime_packs from anon,authenticated,public;
revoke all on public.language_runtime_proposals from anon,authenticated,public;
grant select,insert,update on public.language_runtime_packs to service_role;
grant select,insert,update on public.language_runtime_proposals to service_role;
