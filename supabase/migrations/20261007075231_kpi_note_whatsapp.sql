-- Only KPI-owned objects. A note and its notification are committed together.
begin;

create table public.kpi_note_notifications (
  note_id text primary key references public.kpi_notes(id) on delete cascade,
  assignee_id text not null,
  task_id text not null,
  note_text text not null,
  creator_name text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'accepted')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  provider_id text not null default '',
  last_error text not null default '',
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
alter table public.kpi_note_notifications enable row level security;
revoke all on public.kpi_note_notifications from public, anon, authenticated;
grant select, insert, update, delete on public.kpi_note_notifications to service_role;
create index kpi_note_notifications_pending on public.kpi_note_notifications(next_attempt_at)
where status <> 'accepted';

create function public.kpi_enqueue_note_notification()
returns trigger language plpgsql security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.record->>'AssignedToId', '') <> ''
     and coalesce(new.record->>'AssignedTaskId', '') <> '' then
    insert into public.kpi_note_notifications(note_id, assignee_id, task_id, note_text, creator_name)
    values(new.id, new.record->>'AssignedToId', new.record->>'AssignedTaskId',
      coalesce(new.record->>'Text', ''), coalesce(new.record->>'CreatedByName', ''))
    on conflict (note_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.kpi_enqueue_note_notification() from public, anon, authenticated;
grant execute on function public.kpi_enqueue_note_notification() to service_role;
create trigger kpi_note_notification_created after insert on public.kpi_notes
for each row execute function public.kpi_enqueue_note_notification();

create function public.kpi_claim_note_notification(p_note_id text default null)
returns table(note_id text, assignee_id text, task_id text, note_text text, creator_name text, lease_token uuid)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  selected_id text;
  token uuid := gen_random_uuid();
begin
  select notification.note_id into selected_id
  from public.kpi_note_notifications notification
  where (p_note_id is null or notification.note_id = p_note_id)
    and ((notification.status = 'pending' and notification.next_attempt_at <= now())
      or (notification.status = 'processing' and notification.lease_until < now()))
  order by notification.next_attempt_at, notification.created_at
  for update skip locked limit 1;
  if selected_id is null then return; end if;
  return query update public.kpi_note_notifications notification
  set status = 'processing', lease_token = token, lease_until = now() + interval '10 minutes',
    attempts = notification.attempts + 1
  where notification.note_id = selected_id
  returning notification.note_id, notification.assignee_id, notification.task_id,
    notification.note_text, notification.creator_name, notification.lease_token;
end;
$$;
revoke all on function public.kpi_claim_note_notification(text) from public, anon, authenticated;
grant execute on function public.kpi_claim_note_notification(text) to service_role;

create function public.kpi_finish_note_notification(
  p_note_id text, p_lease_token uuid, p_accepted boolean,
  p_provider_id text default '', p_error text default '')
returns boolean language plpgsql security invoker set search_path = public, pg_temp
as $$
declare affected integer;
begin
  update public.kpi_note_notifications
  set status = case when p_accepted then 'accepted' else 'pending' end,
    provider_id = case when p_accepted then left(coalesce(p_provider_id, ''), 500) else provider_id end,
    last_error = case when p_accepted then '' else left(coalesce(p_error, ''), 300) end,
    accepted_at = case when p_accepted then now() else accepted_at end,
    next_attempt_at = now() + interval '10 minutes', lease_token = null, lease_until = null
  where note_id = p_note_id and lease_token = p_lease_token and status = 'processing';
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;
revoke all on function public.kpi_finish_note_notification(text, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.kpi_finish_note_notification(text, uuid, boolean, text, text) to service_role;

commit;
