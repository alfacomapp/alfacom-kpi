begin;

create table public.kpi_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  auth_user_id uuid not null,
  login text not null,
  role text not null,
  location text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index kpi_sessions_expires_at_idx on public.kpi_sessions (expires_at);
alter table public.kpi_sessions enable row level security;
revoke all on table public.kpi_sessions from anon, authenticated;
grant select, insert, update, delete on table public.kpi_sessions to service_role;

commit;
