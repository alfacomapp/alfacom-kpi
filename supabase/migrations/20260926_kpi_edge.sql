-- Run after supabase-kpi-schema.sql. Only KPI-owned objects are added.
begin;

-- Each scheduled task has one stable period key, even when dashboards open together.
create unique index if not exists kpi_tasks_period_key_unique
on public.kpi_tasks ((record->>'PeriodKey'))
where coalesce(record->>'PeriodKey', '') <> '';

create or replace function public.kpi_apply_changes(changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  change_item jsonb;
  table_name text;
  record_id text;
  operation text;
  expected_revision bigint;
  payload jsonb;
  affected integer;
  applied integer := 0;
begin
  if changes is null or jsonb_typeof(changes) is distinct from 'array' then
    raise exception 'Invalid KPI change batch';
  end if;
  if jsonb_array_length(changes) > 500 then
    raise exception 'Invalid KPI change batch';
  end if;

  for change_item in select value from jsonb_array_elements(changes) loop
    table_name := change_item->>'table';
    record_id := change_item->>'id';
    operation := change_item->>'operation';
    payload := change_item->'record';
    if table_name is null or table_name not in ('kpi_users', 'kpi_notes', 'kpi_reports', 'kpi_tasks', 'kpi_activity_logs')
       or record_id is null or length(record_id) > 200 then
      raise exception 'Invalid KPI table or record id';
    end if;

    if operation = 'insert' then
      if jsonb_typeof(payload) is distinct from 'object' or payload->>'Id' is distinct from record_id then
        raise exception 'Invalid KPI record';
      end if;
      if table_name = 'kpi_tasks' and coalesce(payload->>'PeriodKey', '') <> '' then
        execute format('insert into public.%I (id, record) values ($1, $2) on conflict do nothing', table_name)
          using record_id, payload;
      else
        execute format('insert into public.%I (id, record) values ($1, $2)', table_name)
          using record_id, payload;
      end if;
    elsif operation in ('update', 'delete') then
      expected_revision := (change_item->>'revision')::bigint;
      if expected_revision is null or expected_revision < 1 then
        raise exception 'Invalid KPI revision';
      end if;
      if operation = 'update' then
        if jsonb_typeof(payload) is distinct from 'object' or payload->>'Id' is distinct from record_id then
          raise exception 'Invalid KPI record';
        end if;
        execute format('update public.%I set record = $1, revision = revision + 1 where id = $2 and revision = $3', table_name)
          using payload, record_id, expected_revision;
      else
        execute format('delete from public.%I where id = $1 and revision = $2', table_name)
          using record_id, expected_revision;
      end if;
      get diagnostics affected = row_count;
      if affected <> 1 then
        raise exception 'KPI record changed concurrently: %', record_id using errcode = '40001';
      end if;
    else
      raise exception 'Invalid KPI operation';
    end if;
    applied := applied + 1;
  end loop;

  return jsonb_build_object('applied', applied);
end;
$$;

revoke all on function public.kpi_apply_changes(jsonb) from public, anon, authenticated;
grant execute on function public.kpi_apply_changes(jsonb) to service_role;

insert into storage.buckets (id, name, public)
values ('kpi-uploads', 'kpi-uploads', false)
on conflict (id) do nothing;

commit;
