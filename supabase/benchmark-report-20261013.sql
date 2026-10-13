-- Additive storage for saved desktop reports and isolated E2B executions.
alter table public.runs add column if not exists report jsonb;

create table if not exists public.benchmark_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  language text not null check (language in ('python','cpp','rust','javascript','typescript')),
  program text not null check (octet_length(program) between 1 and 262144),
  stdin text not null default '' check (octet_length(stdin) <= 65536),
  timeout_ms integer not null default 120000 check (timeout_ms between 30000 and 300000),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists benchmark_requests_queue_idx
  on public.benchmark_requests(status, created_at);
alter table public.benchmark_requests enable row level security;
revoke all on public.benchmark_requests from anon, authenticated;
alter table public.benchmark_requests add column if not exists stdin text not null default '';
