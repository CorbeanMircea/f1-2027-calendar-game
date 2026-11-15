-- 037: Administrative corrections of locked predictions (Milestone M6, database part).
--
-- An admin can correct ONE player's saved prediction for a session after predictions have closed, for example to put the
-- replacement of a substituted driver into a prediction. It is exceptional: it never reopens a session, never lets a player
-- edit, and never touches deadlines or locking.
--
--   prediction_corrections   append-only audit log. Every correction and every revert is a row with the full picks before and
--                            after, the original submission timestamps, the mandatory reason, the admin and the time. A
--                            correction can be linked to the driver substitution or grid penalty it relates to.
--   rescore_prediction       (service role only) scores ONE player for ONE session with the existing calc_points and the
--                            approved result, with an upsert on (user_id, session_id). No other player or session is touched.
--   admin_preview_corrections   read-only: the saved predictions of a session, for the admin screen.
--   admin_correct_predictions   one operation for one or several players, all or nothing, one log row per player.
--   admin_revert_correction     restores the picks of the latest correction still in force (last in, first out).
--
-- The player's row in predictions keeps its created_at and updated_at: they are never written here, so a correction can never
-- look like a player edit or a late submission. The original picks stay recoverable from prediction_corrections.
-- Scoring rules, season picks, season bonus points, XP and achievements are not touched: only scores is written, and the
-- leaderboard, XP and achievements are views over it.
--
-- ROLLBACK: supabase/maintenance/rollback_037_prediction_corrections.sql
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

create table public.prediction_corrections (
  id                       uuid        primary key default gen_random_uuid(),
  batch_id                 uuid        not null,
  action                   text        not null check (action in ('correct', 'revert')),
  prediction_id            uuid        not null,      -- no foreign keys on identities: the audit must outlive accounts
  user_id                  uuid        not null,
  session_id               text        not null references public.sessions (id),
  before_picks             jsonb       not null,
  after_picks              jsonb       not null,
  original_created_at      timestamptz not null,      -- the player's own submission time, copied unchanged
  original_updated_at      timestamptz not null,
  reason                   text        not null,
  admin_id                 uuid        not null,
  created_at               timestamptz not null default now(),
  reverts_id               uuid        references public.prediction_corrections (id),
  related_substitution_id  uuid        references public.driver_substitutions (id),
  related_penalty_id       uuid        references public.grid_penalties (id),
  points_before            integer,
  points_after             integer,
  constraint prediction_corrections_reason check (char_length(btrim(reason)) >= 3),
  constraint prediction_corrections_revert_shape check ((action = 'revert') = (reverts_id is not null))
);

create unique index prediction_corrections_one_revert on public.prediction_corrections (reverts_id) where reverts_id is not null;
create index prediction_corrections_prediction_idx on public.prediction_corrections (prediction_id, created_at);
create index prediction_corrections_session_idx on public.prediction_corrections (session_id, created_at);

create trigger prediction_corrections_append_only
  before update or delete on public.prediction_corrections
  for each row execute function public.lo_block_change();

alter table public.prediction_corrections enable row level security;

-- A player reads the corrections of his own predictions; an admin reads all of them.
create policy "players read their own corrections, admins read all"
  on public.prediction_corrections for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

revoke all on public.prediction_corrections from anon, authenticated;
grant select on public.prediction_corrections to authenticated;

-- Scores ONE player for ONE session, exactly like recalculate_scores does for everybody. Returns the new points, or NULL when
-- the session has no approved result (nothing to score yet: the normal approval scores the saved picks later).
create function public.rescore_prediction(p_user uuid, p_session text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_points integer;
begin
  insert into public.scores (user_id, session_id, result_id, points, breakdown)
  select p.user_id, p.session_id, r.id, (c.j ->> 'total')::integer, c.j
  from public.predictions p
  join public.sessions s on s.id = p.session_id
  join public.results r on r.session_id = p.session_id and r.status = 'approved'
  cross join lateral (
    select public.calc_points(s.session_type, p.picks, r.data) as j
  ) c
  where p.user_id = p_user and p.session_id = p_session
  on conflict (user_id, session_id) do update
    set result_id = excluded.result_id,
        points = excluded.points,
        breakdown = excluded.breakdown,
        computed_at = now()
  returning points into v_points;

  return v_points;
end;
$$;

-- The saved predictions of a session, for the admin screen. Read-only.
create function public.admin_preview_corrections(p_session_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s     record;
  v_open  boolean;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select s.id, s.session_type, s.start_utc, e.id as event_id, e.name as event_name, e.season
    into v_s
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;
  if v_s.id is null then
    raise exception 'Unknown session';
  end if;

  v_open := coalesce((select pw.is_open from public.prediction_windows pw where pw.session_id = p_session_id), false);

  return jsonb_build_object(
    'event', jsonb_build_object('id', v_s.event_id, 'name', v_s.event_name, 'season', v_s.season),
    'session', jsonb_build_object('id', v_s.id, 'session_type', v_s.session_type, 'start_utc', v_s.start_utc),
    'predictions_open', v_open,
    'eligible', not v_open,
    'has_approved_result', exists (select 1 from public.results r where r.session_id = p_session_id and r.status = 'approved'),
    'lineup', (select to_jsonb(ls.o_lineup) from public.session_lineup_state(p_session_id) as ls),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', pr.user_id,
               'name', pf.display_name,
               'prediction_id', pr.id,
               'picks', pr.picks,
               'created_at', pr.created_at,
               'updated_at', pr.updated_at,
               'points', sc.points,
               'latest_correction_id', (
                 select c.id from public.prediction_corrections c
                 where c.prediction_id = pr.id and c.action = 'correct'
                   and not exists (select 1 from public.prediction_corrections r2 where r2.reverts_id = c.id)
                 order by c.created_at desc, c.id desc limit 1)
             ) order by pf.display_name)
      from public.predictions pr
      join public.profiles pf on pf.id = pr.user_id
      left join public.scores sc on sc.user_id = pr.user_id and sc.session_id = pr.session_id
      where pr.session_id = p_session_id), '[]'::jsonb));
end;
$$;

-- Corrects the saved predictions of one or several players for one session, in ONE operation (all or nothing).
-- p_items: [{"user_id": "...", "picks": {...}}]. Each new pick set is validated exactly like a player's own save
-- (the effective lineup, withdrawn drivers the player already saved stay valid, qualifying stays a full ranking).
create function public.admin_correct_predictions(
  p_session_id           text,
  p_items                jsonb,
  p_reason               text,
  p_related_substitution uuid default null,
  p_related_penalty      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s       record;
  v_open    boolean;
  v_use     boolean;
  v_line    text[];
  v_stand   jsonb;
  v_item    jsonb;
  v_user    uuid;
  v_new     jsonb;
  v_pred    record;
  v_own     jsonb;
  v_name    text;
  v_batch   uuid := gen_random_uuid();
  v_corr    uuid;
  v_before  integer;
  v_after   integer;
  v_seen    uuid[] := '{}'::uuid[];
  v_out     jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required';
  end if;

  select s.id, s.session_type, e.id as event_id, e.name as event_name, e.season
    into v_s
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;
  if v_s.id is null then
    raise exception 'Unknown session';
  end if;

  -- Exceptional: only when the players themselves can no longer edit. This never reopens a session.
  v_open := coalesce((select pw.is_open from public.prediction_windows pw where pw.session_id = p_session_id), false);
  if v_open then
    raise exception 'Predictions are still open for this session: players can still edit their own';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one player';
  end if;

  if p_related_substitution is not null
     and not exists (select 1 from public.driver_substitutions d where d.id = p_related_substitution and d.event_id = v_s.event_id) then
    raise exception 'The linked substitution does not belong to this Grand Prix';
  end if;
  if p_related_penalty is not null
     and not exists (select 1 from public.grid_penalties g join public.sessions gs on gs.id = g.session_id
                     where g.id = p_related_penalty and gs.event_id = v_s.event_id) then
    raise exception 'The linked grid penalty does not belong to this Grand Prix';
  end if;

  select ls.o_use, ls.o_lineup, ls.o_stand_ins into v_use, v_line, v_stand
  from public.session_lineup_state(p_session_id) as ls;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_user := (v_item ->> 'user_id')::uuid;
    v_new  := v_item -> 'picks';

    if v_user = any (v_seen) then
      raise exception 'Each player can be corrected only once per operation';
    end if;
    v_seen := v_seen || v_user;

    select pf.display_name into v_name from public.profiles pf where pf.id = v_user;

    select pr.id, pr.picks, pr.created_at, pr.updated_at into v_pred
    from public.predictions pr
    where pr.user_id = v_user and pr.session_id = p_session_id
    for update;
    if v_pred.id is null then
      raise exception '% has no saved prediction for this session', coalesce(v_name, 'A selected player');
    end if;

    if v_new is null or jsonb_typeof(v_new) <> 'object' then
      raise exception 'The corrected picks for % are missing', coalesce(v_name, 'a player');
    end if;
    if v_new = v_pred.picks then
      raise exception 'The corrected picks for % are the same as the saved ones', coalesce(v_name, 'a player');
    end if;

    v_own := coalesce((
      select jsonb_object_agg(k.key, k.value)
      from jsonb_each_text(v_stand) as k
      where k.key = any (public.picks_driver_ids(v_pred.picks))), '{}'::jsonb);

    -- The same validation as a player's own save. A failure names the player and undoes the whole operation.
    begin
      perform public.validate_session_data(
        v_s.session_type, v_new, v_s.season, false,
        case when v_use then v_line end,
        case when v_use then v_own end);
    exception when others then
      raise exception 'Cannot correct %: %', coalesce(v_name, 'a player'), sqlerrm;
    end;

    select sc.points into v_before from public.scores sc where sc.user_id = v_user and sc.session_id = p_session_id;

    -- Only picks change. created_at and updated_at are NOT written: the player's submission time stays exactly as it was.
    update public.predictions set picks = v_new where id = v_pred.id;

    v_after := public.rescore_prediction(v_user, p_session_id);

    insert into public.prediction_corrections
      (batch_id, action, prediction_id, user_id, session_id, before_picks, after_picks,
       original_created_at, original_updated_at, reason, admin_id,
       related_substitution_id, related_penalty_id, points_before, points_after)
    values
      (v_batch, 'correct', v_pred.id, v_user, p_session_id, v_pred.picks, v_new,
       v_pred.created_at, v_pred.updated_at, btrim(p_reason), auth.uid(),
       p_related_substitution, p_related_penalty, v_before, v_after)
    returning id into v_corr;

    insert into public.player_notifications (user_id, kind, source_id, event_id, payload)
    values (v_user, 'prediction_corrected', v_corr, v_s.event_id,
            jsonb_build_object(
              'grand_prix', v_s.event_name, 'event_id', v_s.event_id, 'session', v_s.session_type,
              'reverted', false, 'reason', btrim(p_reason),
              'points_before', v_before, 'points_after', v_after, 'registered_at', now()))
    on conflict (user_id, kind, source_id) do nothing;

    v_out := v_out || jsonb_build_object('user_id', v_user, 'name', v_name, 'correction_id', v_corr,
                                         'points_before', v_before, 'points_after', v_after);
  end loop;

  return jsonb_build_object('batch_id', v_batch, 'corrected', jsonb_array_length(v_out), 'players', v_out);
end;
$$;

-- Restores the picks from before the latest correction still in force for that prediction (last in, first out).
-- The revert is a new row; nothing is edited or deleted. The restored picks are the ones the player (or the previous
-- correction) had, so they are not validated again.
create function public.admin_revert_correction(p_correction_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c       record;
  v_s       record;
  v_pred    record;
  v_open    boolean;
  v_rev     uuid;
  v_before  integer;
  v_after   integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required';
  end if;

  select c.id, c.prediction_id, c.user_id, c.session_id, c.before_picks, c.after_picks, c.created_at,
         c.related_substitution_id, c.related_penalty_id
    into v_c
  from public.prediction_corrections c
  where c.id = p_correction_id and c.action = 'correct';
  if v_c.id is null then
    raise exception 'Unknown correction';
  end if;
  if exists (select 1 from public.prediction_corrections r where r.reverts_id = p_correction_id) then
    raise exception 'This correction has already been reverted';
  end if;
  if exists (
    select 1 from public.prediction_corrections c2
    where c2.prediction_id = v_c.prediction_id and c2.action = 'correct'
      and (c2.created_at, c2.id) > (v_c.created_at, v_c.id)
      and not exists (select 1 from public.prediction_corrections r2 where r2.reverts_id = c2.id)
  ) then
    raise exception 'A later correction of this prediction is still in force: revert that one first';
  end if;

  select s.id, s.session_type, e.id as event_id, e.name as event_name into v_s
  from public.sessions s join public.events e on e.id = s.event_id where s.id = v_c.session_id;

  v_open := coalesce((select pw.is_open from public.prediction_windows pw where pw.session_id = v_c.session_id), false);
  if v_open then
    raise exception 'Predictions are still open for this session: players can still edit their own';
  end if;

  select pr.id, pr.picks, pr.created_at, pr.updated_at into v_pred
  from public.predictions pr where pr.id = v_c.prediction_id for update;
  if v_pred.id is null then
    raise exception 'The prediction no longer exists';
  end if;
  if v_pred.picks <> v_c.after_picks then
    raise exception 'The prediction has changed since this correction was made';
  end if;

  select sc.points into v_before from public.scores sc where sc.user_id = v_c.user_id and sc.session_id = v_c.session_id;

  update public.predictions set picks = v_c.before_picks where id = v_pred.id;
  v_after := public.rescore_prediction(v_c.user_id, v_c.session_id);

  insert into public.prediction_corrections
    (batch_id, action, prediction_id, user_id, session_id, before_picks, after_picks,
     original_created_at, original_updated_at, reason, admin_id, reverts_id,
     related_substitution_id, related_penalty_id, points_before, points_after)
  values
    (gen_random_uuid(), 'revert', v_pred.id, v_c.user_id, v_c.session_id, v_c.after_picks, v_c.before_picks,
     v_pred.created_at, v_pred.updated_at, btrim(p_reason), auth.uid(), p_correction_id,
     v_c.related_substitution_id, v_c.related_penalty_id, v_before, v_after)
  returning id into v_rev;

  insert into public.player_notifications (user_id, kind, source_id, event_id, payload)
  values (v_c.user_id, 'prediction_corrected', v_rev, v_s.event_id,
          jsonb_build_object(
            'grand_prix', v_s.event_name, 'event_id', v_s.event_id, 'session', v_s.session_type,
            'reverted', true, 'reason', btrim(p_reason),
            'points_before', v_before, 'points_after', v_after, 'registered_at', now()))
  on conflict (user_id, kind, source_id) do nothing;

  return jsonb_build_object('revert_id', v_rev, 'points_before', v_before, 'points_after', v_after);
end;
$$;

-- Permissions
revoke all on function public.rescore_prediction(uuid, text) from public, anon, authenticated;
grant execute on function public.rescore_prediction(uuid, text) to service_role;

revoke all on function public.admin_preview_corrections(text)                                  from public, anon;
revoke all on function public.admin_correct_predictions(text, jsonb, text, uuid, uuid)         from public, anon;
revoke all on function public.admin_revert_correction(uuid, text)                              from public, anon;
grant execute on function public.admin_preview_corrections(text)                                  to authenticated;
grant execute on function public.admin_correct_predictions(text, jsonb, text, uuid, uuid)         to authenticated;
grant execute on function public.admin_revert_correction(uuid, text)                              to authenticated;

do $$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'rescore_prediction'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    v_bad := v_bad || r.fn || '; ';
  end loop;
  if v_bad <> '' then
    raise exception 'Unexpected EXECUTE rights (anon, authenticated or PUBLIC) on: %', v_bad;
  end if;

  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('admin_preview_corrections', 'admin_correct_predictions', 'admin_revert_correction')
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
