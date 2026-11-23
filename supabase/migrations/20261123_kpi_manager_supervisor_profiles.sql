-- Preserve Abu Abdillah's KPI identity and task history when the SLA manager
-- login gets its own KPI role. The separate abuanis login starts with no duties;
-- the manager can move running tasks to Supervisor through Task Manager.
begin;

update public.kpi_users
set record = record || jsonb_build_object(
  'Role', 'manager', 'SlaLogin', 'manager', 'Position', 'Manager',
  'UpdatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
),
revision = revision + 1
where id = 'USR-BE32AEA8-1788837765277'
  and lower(record->>'Name') = 'abu abdillah'
  and record->>'Role' = 'auditor'
  and coalesce(record->>'SlaLogin', '') = '';

insert into public.kpi_users (id, record)
select 'KPI-SLA-abuanis', jsonb_build_object(
  'Id', 'KPI-SLA-abuanis', 'Username', 'abuanis', 'SlaLogin', 'abuanis',
  'Name', 'Abu Anis', 'Position', 'Supervisor', 'Role', 'supervisor',
  'Location', 'all', 'Active', true,
  'Menus', jsonb_build_array('dashboard', 'laporan', 'profil'),
  'CreatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
)
where exists (
  select 1 from public.users
  where username_login = 'abuanis' and lower(role) = 'manager'
)
on conflict (id) do nothing;

commit;
