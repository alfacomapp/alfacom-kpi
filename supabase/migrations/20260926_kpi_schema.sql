-- Dedicated KPI storage. This migration does not alter SLA tables, including absensi.
begin;

create table public.kpi_users (
  id text primary key,
  seq bigint generated always as identity unique,
  record jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  inserted_at timestamptz not null default now(),
  constraint kpi_users_record_id check (record->>'Id' = id)
);
alter table public.kpi_users enable row level security;
create table public.kpi_notes (like public.kpi_users including all);
alter table public.kpi_notes enable row level security;
create table public.kpi_reports (like public.kpi_users including all);
alter table public.kpi_reports enable row level security;
create table public.kpi_tasks (like public.kpi_users including all);
alter table public.kpi_tasks enable row level security;
create table public.kpi_activity_logs (like public.kpi_users including all);
alter table public.kpi_activity_logs enable row level security;
create table public.kpi_reference (like public.kpi_users including all);
alter table public.kpi_reference enable row level security;

-- All KPI data stays server-side. Existing SLA grants and policies are unchanged.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'kpi_users', 'kpi_notes', 'kpi_reports', 'kpi_tasks',
    'kpi_activity_logs', 'kpi_reference'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
    execute format('grant usage, select on sequence %s to service_role',
      pg_get_serial_sequence(format('public.%I', table_name), 'seq'));
  end loop;
end $$;

commit;
