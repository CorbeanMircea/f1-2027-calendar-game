-- 016: Admin panel support: review, approve and reject results from the website.

-- 1) A result can now also be rejected.
alter table public.results drop constraint if exists results_status_check;
alter table public.results add constraint results_status_check
  check (status in ('pending', 'approved', 'superseded', 'rejected'));

-- 2) Admin = a group member with the 'admin' role.
create function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.group_members
    where user_id = auth.uid() and role = 'admin'
  );
$$;

-- 3) Everything the panel shows, in one call.
create function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'pending', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.entered_at)
      from (
        select r.id, r.session_id, r.version, r.source, r.entered_at, r.data,
               e.name as event_name, s.session_type,
               public.is_prediction_locked(r.session_id) as locked,
               (select count(*) from public.predictions pr where pr.session_id = r.session_id) as predictions,
               (select jsonb_build_object('version', a.version, 'data', a.data)
                  from public.results a
                 where a.session_id = r.session_id and a.status = 'approved') as approved
        from public.results r
        join public.sessions s on s.id = r.session_id
        join public.events e on e.id = s.event_id
        where r.status = 'pending'
      ) p
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.approved_at desc)
      from (
        select r.id, r.session_id, r.version, r.source, r.approved_at,
               e.name as event_name, s.session_type
        from public.results r
        join public.sessions s on s.id = r.session_id
        join public.events e on e.id = s.event_id
        where r.status = 'approved'
        order by r.approved_at desc nulls last
        limit 10
      ) q
    ), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
      from (
        select created_at, event_id, session_type, action, detail
        from public.import_log
        order by created_at desc
        limit 30
      ) l
    ), '[]'::jsonb)
  );
end;
$$;

-- 4) Approve (same rules as before; records who approved).
create function public.admin_approve_result(p_result_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  perform public.approve_result(p_result_id, auth.uid());
end;
$$;

-- 5) Reject a pending result.
create function public.admin_reject_result(p_result_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update public.results set status = 'rejected'
  where id = p_result_id and status = 'pending';
  if not found then
    raise exception 'Result not found or not pending';
  end if;
end;
$$;

-- 6) Privileges: only signed-in users can call these, and each one checks is_admin() itself.
revoke all on function public.is_admin()                   from public, anon;
revoke all on function public.admin_overview()             from public, anon;
revoke all on function public.admin_approve_result(uuid)   from public, anon;
revoke all on function public.admin_reject_result(uuid)    from public, anon;

grant execute on function public.is_admin()                 to authenticated;
grant execute on function public.admin_overview()           to authenticated;
grant execute on function public.admin_approve_result(uuid) to authenticated;
grant execute on function public.admin_reject_result(uuid)  to authenticated;
