-- 032: Fix for admin_preview_substitution (migration 031).
-- Found on first use: with "New driver" selected the function read a record variable that had never been assigned,
-- and failed with: record "v_in" is not assigned yet. The replacement is now read with a subquery instead.
-- Same signature, same result shape, same permissions. Nothing else changes; no data is read or written beyond the preview.
-- No rollback file: the previous version was the faulty one.
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

create or replace function public.admin_preview_substitution(p_event_id text, p_out_driver text, p_in_driver text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ev   record;
  v_out  record;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select e.id, e.name, e.season, e.status into v_ev from public.events e where e.id = p_event_id;
  if v_ev.id is null then
    raise exception 'Unknown event';
  end if;

  select d.id, d.code, d.full_name, d.team_name, d.car_number into v_out
  from public.drivers d where d.id = p_out_driver and d.season = v_ev.season;
  if v_out.id is null then
    raise exception 'Unknown outgoing driver for this season';
  end if;

  if p_in_driver is not null
     and not exists (select 1 from public.drivers d where d.id = p_in_driver and d.season = v_ev.season) then
    raise exception 'Unknown replacement driver for this season';
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object('id', v_ev.id, 'name', v_ev.name, 'season', v_ev.season, 'status', v_ev.status),
    'out', jsonb_build_object('id', v_out.id, 'code', v_out.code, 'name', v_out.full_name, 'team', v_out.team_name, 'number', v_out.car_number),
    'in', (select jsonb_build_object('id', d.id, 'code', d.code, 'name', d.full_name, 'team', d.team_name, 'number', d.car_number)
           from public.drivers d where d.id = p_in_driver and d.season = v_ev.season),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'session_id', t.id,
               'session_type', t.session_type,
               'start_utc', t.start_utc,
               'timing', t.timing,
               'out_in_lineup', t.out_in,
               'in_in_lineup', t.in_in,
               'predictions', t.preds,
               'eligible', (t.timing <> 'taken_place' and t.out_in and not t.in_in),
               'default_selected', (t.timing = 'remaining' and t.out_in and not t.in_in),
               'needs_confirmation', (t.timing = 'unknown' and t.out_in and not t.in_in),
               'reason', case
                           when t.timing = 'taken_place' then 'Already taken place'
                           when not t.out_in then 'The outgoing driver is not in the lineup for this session'
                           when t.in_in then 'The replacement is already in the lineup for this session'
                           when t.timing = 'unknown' then 'Start time unknown: tick it to include it'
                           else null end
             ) order by t.sort)
      from (
        select s.id, s.session_type, s.start_utc,
               case s.session_type when 'sprint_qualifying' then 1 when 'sprint' then 2 when 'qualifying' then 3 else 4 end as sort,
               case
                 when exists (select 1 from public.results r where r.session_id = s.id and r.status in ('pending', 'approved'))
                      or (s.start_utc is not null and s.start_utc <= now()) then 'taken_place'
                 when s.start_utc is null then 'unknown'
                 else 'remaining'
               end as timing,
               (p_out_driver = any (ls.o_lineup)) as out_in,
               (p_in_driver is not null and p_in_driver = any (ls.o_lineup)) as in_in,
               (select count(*) from public.predictions pr where pr.session_id = s.id) as preds
        from public.sessions s, lateral public.session_lineup_state(s.id) as ls
        where s.event_id = p_event_id
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_preview_substitution(text, text, text) from public, anon;
grant execute on function public.admin_preview_substitution(text, text, text) to authenticated;

do $$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'admin_preview_substitution'
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
