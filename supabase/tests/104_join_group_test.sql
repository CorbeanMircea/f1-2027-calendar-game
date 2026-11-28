-- Behaviour test for joining the friends group (join_group, migration 003). It had no test before.
-- Run it in the Supabase SQL Editor or with npm run test:sql. It ends with an ERROR ON PURPOSE that rolls everything back.
-- It creates three made-up users (rolled back at the end) and reads the group's real invite code from the database,
-- so it works on the local test database and on production alike.

do $$
declare
  r       text := '';
  v_code  text;
  v_group uuid;
  v_u1    uuid := '99999999-0000-4000-8000-0000000000a1';
  v_u2    uuid := '99999999-0000-4000-8000-0000000000a2';
  v_u3    uuid := '99999999-0000-4000-8000-0000000000a3';
  v_got   uuid;
  v_msg   text;
  v_state text;
  v_n     integer;
  v_name  text;
begin
  select id, invite_code into v_group, v_code from public.groups order by created_at limit 1;
  if v_group is null then raise exception 'The test needs the friends group to exist'; end if;

  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  values (v_u1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sqltest-join-1@lightsout.test', now()),
         (v_u2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sqltest-join-2@lightsout.test', now()),
         (v_u3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sqltest-join-3@lightsout.test', now());

  -- 1. Not signed in ------------------------------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  v_msg := null; v_state := null;
  begin perform public.join_group(v_code, 'Nobody Here'); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
  reset role;
  r := r || case when v_msg = 'You must be signed in' and v_state = '28000' then 'ok    ' else 'FAIL  ' end || E'nobody signed in cannot join\n';

  -- 2. The invite code: typed freely, but it must be right -------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  set local role authenticated;
  v_msg := null; v_state := null;
  begin perform public.join_group('WRONG-CODE-123', 'Test Joiner One'); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
  r := r || case when v_msg = 'Invalid invite code' and v_state = '22023' then 'ok    ' else 'FAIL  ' end || E'a wrong invite code is refused\n';
  v_msg := null;
  begin perform public.join_group(null, 'Test Joiner One'); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Invalid invite code' then 'ok    ' else 'FAIL  ' end || E'a missing invite code is refused\n';
  v_msg := null;
  begin perform public.join_group('   ', 'Test Joiner One'); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Invalid invite code' then 'ok    ' else 'FAIL  ' end || E'a blank invite code is refused\n';
  reset role;
  select count(*) into v_n from public.group_members where user_id = v_u1;
  select count(*) into v_name from public.profiles where id = v_u1;
  r := r || case when v_n = 0 and v_name::int = 0 then 'ok    ' else 'FAIL  ' end || E'refused attempts leave no membership and no profile behind\n';

  -- 3. The display name rules -------------------------------------------------------------------------------------------------------------
  set local role authenticated;
  v_msg := null;
  begin perform public.join_group(v_code, 'A'); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Display name must be 2 to 30 characters' then 'ok    ' else 'FAIL  ' end || E'a one-character name is refused\n';
  v_msg := null;
  begin perform public.join_group(v_code, repeat('x', 31)); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Display name must be 2 to 30 characters' then 'ok    ' else 'FAIL  ' end || E'a 31-character name is refused\n';
  v_msg := null;
  begin perform public.join_group(v_code, '   a   '); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Display name must be 2 to 30 characters' then 'ok    ' else 'FAIL  ' end || E'spaces do not count towards the length\n';
  v_msg := null;
  begin perform public.join_group(v_code, null); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Display name must be 2 to 30 characters' then 'ok    ' else 'FAIL  ' end || E'a missing name is refused\n';

  -- 4. A successful join (the code typed in lower case with spaces and dashes) -----------------------------------------------------------------
  v_got := public.join_group(lower(substr(v_code, 1, 3)) || ' - ' || lower(substr(v_code, 4)), '  Joiner One  ');
  reset role;
  r := r || case when v_got = v_group then 'ok    ' else 'FAIL  ' end || E'joining returns the group, and the code ignores case, spaces and dashes\n';
  select count(*), max(role) into v_n, v_msg from public.group_members where user_id = v_u1 and group_id = v_group;
  r := r || case when v_n = 1 and v_msg = 'member' then 'ok    ' else 'FAIL  ' end || E'a new member joins as a plain member, never as an admin\n';
  select display_name into v_name from public.profiles where id = v_u1;
  r := r || case when v_name = 'Joiner One' then 'ok    ' else 'FAIL  ' end || E'the display name is saved without the surrounding spaces\n';

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u2::text, true);
  perform public.join_group(v_code, repeat('y', 30));
  reset role;
  select count(*) into v_n from public.profiles where id = v_u2 and char_length(display_name) = 30;
  r := r || case when v_n = 1 then 'ok    ' else 'FAIL  ' end || E'a 30-character name is accepted\n';
  select count(*) into v_n from public.group_members where user_id = v_u2;
  r := r || case when v_n = 1 then 'ok    ' else 'FAIL  ' end || E'the second player is a member too\n';

  -- 5. Names are unique, ignoring upper and lower case -------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_u3, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u3::text, true);
  set local role authenticated;
  v_msg := null; v_state := null;
  begin perform public.join_group(v_code, 'JOINER ONE'); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
  reset role;
  r := r || case when v_msg = 'That display name is already taken' and v_state = '22023' then 'ok    ' else 'FAIL  ' end
         || E'a display name that is taken (in any capitals) is refused\n';
  select count(*) into v_n from public.group_members where user_id = v_u3;
  select count(*) into v_name from public.profiles where id = v_u3;
  r := r || case when v_n = 0 and v_name::int = 0 then 'ok    ' else 'FAIL  ' end || E'a refused name leaves no membership and no profile behind\n';

  -- 6. Joining again (documented behaviour: it renames the player and never adds a second membership) -----------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  set local role authenticated;
  perform public.join_group(v_code, 'Joiner Renamed');
  reset role;
  select count(*) into v_n from public.group_members where user_id = v_u1;
  select display_name into v_name from public.profiles where id = v_u1;
  r := r || case when v_n = 1 and v_name = 'Joiner Renamed' then 'ok    ' else 'FAIL  ' end
         || E'joining again with the code renames the player and keeps a single membership\n';

  raise exception E'JOIN GROUP TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
