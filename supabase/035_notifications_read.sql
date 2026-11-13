-- 035: Notifications, mark as read (Milestone M5, database part).
--
-- One function lets a signed-in player mark HIS OWN notifications as read. It changes only read_at, only on his own rows.
-- Notifications stay informational: reading or ignoring one has no effect on predictions, deadlines, locking or scoring.
-- ROLLBACK: supabase/maintenance/rollback_035_notifications_read.sql
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

create function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;

  update public.player_notifications n
     set read_at = now()
   where n.user_id = v_user
     and n.read_at is null
     and (p_ids is null or n.id = any (p_ids));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

do $$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'mark_notifications_read'
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    v_bad := v_bad || r.fn || '; ';
  end loop;
  if v_bad <> '' then
    raise exception 'Unexpected function permissions on: %', v_bad;
  end if;
end;
$$;

commit;
