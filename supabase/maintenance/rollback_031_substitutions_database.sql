-- ROLLBACK for 031_substitutions_database.sql
-- Restores session_lineup_state() to its 030 version, removes the three admin substitution functions and lo_notify_change(),
-- and removes player_notifications and driver_substitution_sessions.batch_id ONLY if they hold no data.
-- Driver rows created by admin_register_substitution (inactive replacements) are never deleted.
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

-- 1. Previous (030) version of the lineup function.
create or replace function public.session_lineup_state(p_session_id text)
returns table (o_use boolean, o_lineup text[], o_stand_ins jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_season    integer;
  v_event     text;
  v_line      text[];
  v_succ      jsonb := '{}'::jsonb;
  v_outs      text[] := '{}'::text[];
  v_map       jsonb := '{}'::jsonb;
  v_has       boolean := false;
  v_inactive  boolean;
  r           record;
  w           text;
  cur         text;
  i           integer;
begin
  select e.season, e.id into v_season, v_event
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;

  if v_season is null then
    return query select false, '{}'::text[], '{}'::jsonb;
    return;
  end if;

  v_line := coalesce(
    array(select d.id from public.drivers d where d.season = v_season and d.is_active order by d.code),
    '{}'::text[]);

  select exists (select 1 from public.drivers d where d.season = v_season and not d.is_active)
    into v_inactive;

  for r in
    select ds.out_driver_id as out_id, ds.in_driver_id as in_id
    from public.driver_substitutions ds
    where ds.event_id = v_event
      and exists (
        select 1
        from public.driver_substitution_sessions x
        where x.substitution_id = ds.id
          and x.session_id = p_session_id
          and x.action = 'apply'
          and not exists (
            select 1
            from public.driver_substitution_sessions y
            where y.substitution_id = x.substitution_id
              and y.session_id = x.session_id
              and y.seq > x.seq))
    order by ds.registered_at, ds.id
  loop
    v_has := true;
    v_line := array_remove(v_line, r.out_id);
    if not (r.in_id = any (v_line)) then
      v_line := v_line || r.in_id;
    end if;
    v_succ := v_succ || jsonb_build_object(r.out_id, r.in_id);
    v_outs := v_outs || r.out_id;
  end loop;

  -- Resolve every withdrawn driver to the lineup driver who finally took his place (chains A -> B -> C).
  foreach w in array v_outs loop
    if w = any (v_line) then
      continue;
    end if;
    cur := w;
    i := 0;
    while not (cur = any (v_line)) and (v_succ ? cur) and i < 50 loop
      cur := v_succ ->> cur;
      i := i + 1;
    end loop;
    if cur = any (v_line) then
      v_map := v_map || jsonb_build_object(w, cur);
    end if;
  end loop;

  return query select (v_has or v_inactive), v_line, v_map;
end;
$$;

revoke all on function public.session_lineup_state(text) from public, anon, authenticated;
grant execute on function public.session_lineup_state(text) to service_role;

-- 2. Admin functions and the notification helper added by 031.
drop function public.admin_preview_substitution(text, text, text);
drop function public.admin_register_substitution(text, text, text, jsonb, text[], text[], text);
drop function public.admin_revert_substitution(uuid, text, text[], text[]);
drop function public.lo_notify_change(text, uuid, text, text[], jsonb);

-- 3. Notifications table and batch_id: removed only when empty (never lose data).
do $$
begin
  if (select count(*) from public.player_notifications) = 0 then
    drop table public.player_notifications;
    raise notice 'player_notifications was empty and has been removed.';
  else
    raise notice 'player_notifications contains rows and was KEPT.';
  end if;

  if (select count(*) from public.driver_substitution_sessions) = 0 then
    alter table public.driver_substitution_sessions drop column batch_id;
    raise notice 'batch_id was removed (the table is empty).';
  else
    raise notice 'driver_substitution_sessions contains rows: batch_id was KEPT.';
  end if;
end;
$$;

commit;
