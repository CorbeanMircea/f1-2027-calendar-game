-- Behaviour test for migration 027. Run it in the Supabase SQL Editor.
-- It ends with an ERROR ON PURPOSE that rolls everything back; the message is the report.

do $$
declare
  r        text := '';
  v_admin  uuid;
  v_m1     uuid;
  v_m2     uuid;
  v_over   jsonb;
  v_row    jsonb;
  v_d      text;
  v_t      text;
begin
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  select user_id into v_m1 from public.group_members where user_id <> v_admin order by joined_at limit 1;
  select user_id into v_m2 from public.group_members where user_id <> v_admin and user_id <> v_m1 order by joined_at limit 1;
  if v_admin is null or v_m1 is null or v_m2 is null then
    raise exception 'The test needs one admin and two other group members';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name, car_number, external_id, is_active)
  select replace(d.id, '2026-', '2027-'), 2027, d.code, d.full_name, d.team_name, d.car_number, null, true
  from public.drivers d where d.season = 2026
  on conflict do nothing;
  select d.id, d.team_name into v_d, v_t from public.drivers d where d.season = 2027 order by d.id limit 1;

  update public.sessions set start_utc = now() + interval '30 days'
   where event_id in (select id from public.events where season = 2027 and round = 1);

  insert into public.season_predictions (user_id, season, drivers_pick, constructors_pick) values (v_m1, 2027, v_d, v_t);

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_over := public.admin_season_overview();
  reset role;

  select x into v_row from jsonb_array_elements(v_over) x where (x ->> 'season')::int = 2027;

  r := r || case when v_row is not null then 'ok    ' else 'FAIL  ' end || E'overview lists season 2027\n';
  r := r || case when exists (select 1 from jsonb_array_elements(v_row -> 'missing') m
                              where m ->> 'user_id' = v_m2::text and coalesce(m ->> 'name', '') <> '')
                 then 'ok    ' else 'FAIL  ' end || E'a player without picks appears in missing with user_id and name\n';
  r := r || case when not exists (select 1 from jsonb_array_elements(v_row -> 'missing') m where m ->> 'user_id' = v_m1::text)
                 then 'ok    ' else 'FAIL  ' end || E'a player with picks is not in missing\n';
  r := r || case when exists (select 1 from jsonb_array_elements(v_row -> 'picks') p where p ->> 'user_id' = v_m1::text)
                 then 'ok    ' else 'FAIL  ' end || E'picks still carry the user id\n';
  r := r || case when (v_row ->> 'picks_count')::int = 1 then 'ok    ' else 'FAIL  ' end || E'picks_count is 1\n';

  raise exception E'B2.3b DATABASE TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;