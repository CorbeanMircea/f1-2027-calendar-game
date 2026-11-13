-- 033: Prediction form lineup (Milestone M3, database part).
--
-- One read-only function for the Predictions page: prediction_form_lineup(session).
-- It returns, for the signed-in group member:
--   use        true when a substitution applies to the session (or the season has an inactive driver row)
--   lineup     the effective lineup (driver ids)
--   stand_ins  {withdrawn driver id: his replacement} ONLY for withdrawn drivers this player already saved for the session
--              (the same rule submit_prediction uses, from the same functions: one source of truth)
--   changes    the substitutions that apply to, or were reverted for, this session (for the "Weekend changes" strip)
--
-- It writes nothing, changes no prediction, deadline or lock, and touches no season data.
-- ROLLBACK: supabase/maintenance/rollback_033_prediction_form_lineup.sql
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

create function public.prediction_form_lineup(p_session_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_event    text;
  v_use      boolean;
  v_line     text[];
  v_stand    jsonb;
  v_old      jsonb;
  v_own      jsonb;
  v_changes  jsonb;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  if not exists (select 1 from public.group_members where user_id = v_user) then
    raise exception 'Join the friends group first' using errcode = '42501';
  end if;

  select s.event_id into v_event from public.sessions s where s.id = p_session_id;
  if v_event is null then
    raise exception 'Unknown session' using errcode = '22023';
  end if;

  select ls.o_use, ls.o_lineup, ls.o_stand_ins into v_use, v_line, v_stand
  from public.session_lineup_state(p_session_id) as ls;

  select pr.picks into v_old
  from public.predictions pr
  where pr.user_id = v_user and pr.session_id = p_session_id;

  v_own := coalesce((
    select jsonb_object_agg(k.key, k.value)
    from jsonb_each_text(v_stand) as k
    where k.key = any (public.picks_driver_ids(v_old))), '{}'::jsonb);

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'kind', 'substitution',
             'status', case l.action when 'apply' then 'applied' else 'reverted' end,
             'out', jsonb_build_object('id', ds.out_driver_id) || ds.out_info,
             'in', jsonb_build_object('id', ds.in_driver_id) || ds.in_info,
             'registered_at', ds.registered_at,
             'changed_at', l.acted_at)
           order by ds.registered_at, ds.id), '[]'::jsonb)
    into v_changes
  from public.driver_substitutions ds
  join lateral (
    select x.action, x.acted_at
    from public.driver_substitution_sessions x
    where x.substitution_id = ds.id and x.session_id = p_session_id
    order by x.seq desc
    limit 1
  ) l on true
  where ds.event_id = v_event;

  return jsonb_build_object(
    'use', v_use,
    'lineup', to_jsonb(v_line),
    'stand_ins', case when v_use then v_own else '{}'::jsonb end,
    'changes', v_changes);
end;
$$;

revoke all on function public.prediction_form_lineup(text) from public, anon;
grant execute on function public.prediction_form_lineup(text) to authenticated;

do $$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'prediction_form_lineup'
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
