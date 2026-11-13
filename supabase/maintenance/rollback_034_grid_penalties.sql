-- ROLLBACK for 034_grid_penalties.sql
-- Restores the 033 version of prediction_form_lineup, removes the penalty functions, and removes grid_penalties ONLY if it is
-- empty (it is kept, with a notice, if it holds rows: no data is ever lost). Predictions, results and scores are never touched.
-- Roll back the site files and the importer first (predict-tiles.js, admin.html, admin-penalties.js, import-results).
begin;

create or replace function public.prediction_form_lineup(p_session_id text)
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

drop function public.admin_preview_grid_penalty(text);
drop function public.admin_register_grid_penalty(text, text, text, integer, integer, integer, text, text, boolean);
drop function public.admin_revoke_grid_penalty(uuid, text, jsonb);
drop function public.session_has_grid_penalty(text);

do $$
begin
  if (select count(*) from public.grid_penalties) = 0 then
    drop table public.grid_penalties;
    raise notice 'grid_penalties was empty and has been removed.';
  else
    raise notice 'grid_penalties contains rows and was KEPT (no data was removed).';
  end if;
end;
$$;

commit;
