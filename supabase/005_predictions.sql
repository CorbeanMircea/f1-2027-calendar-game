-- 005: Predictions. Writes happen ONLY through submit_prediction().
-- Deadlines, picks and membership are all checked on the server.

-- Table ------------------------------------------------------------------

create table public.predictions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  session_id    text not null references public.sessions (id) on delete cascade,
  p1            text not null references public.drivers (id),
  p2            text not null references public.drivers (id),
  p3            text not null references public.drivers (id),
  p4            text references public.drivers (id),
  p5            text references public.drivers (id),
  pole          text references public.drivers (id),
  fastest_lap   text references public.drivers (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, session_id)
);
create index predictions_session_idx on public.predictions (session_id);

alter table public.predictions enable row level security;

-- Is the lock time for this prediction target in the past? (NULL time = not locked)

create function public.is_prediction_locked(p_session_id text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((
    select l.start_utc is not null and now() >= l.start_utc
    from public.sessions s
    join public.sessions l
      on l.event_id = s.event_id
     and l.session_type = case s.session_type
                            when 'race'   then 'qualifying'
                            when 'sprint' then 'sprint_qualifying'
                          end
    where s.id = p_session_id
  ), false);
$$;

-- Read policy: your own picks always; group-mates' picks only after the lock.

create policy "read own predictions, or group-mates after lock"
  on public.predictions for select to authenticated
  using (
    user_id = auth.uid()
    or (public.shares_group_with(user_id) and public.is_prediction_locked(session_id))
  );

-- The only write path --------------------------------------------------------

create function public.submit_prediction(
  p_session_id   text,
  p_p1           text,
  p_p2           text,
  p_p3           text,
  p_p4           text default null,
  p_p5           text default null,
  p_pole         text default null,
  p_fastest_lap  text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_type    text;
  v_season  integer;
  v_status  text;
  v_lock    timestamptz;
  v_top     text[];
  v_all     text[];
  v_id      uuid;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;

  if not exists (select 1 from public.group_members where user_id = v_user) then
    raise exception 'Join the friends group before predicting' using errcode = '42501';
  end if;

  select s.session_type, e.season, e.status, l.start_utc
    into v_type, v_season, v_status, v_lock
  from public.sessions s
  join public.events e on e.id = s.event_id
  left join public.sessions l
    on l.event_id = s.event_id
   and l.session_type = case s.session_type
                          when 'race'   then 'qualifying'
                          when 'sprint' then 'sprint_qualifying'
                        end
  where s.id = p_session_id
    and s.session_type in ('race', 'sprint');

  if v_type is null then
    raise exception 'Unknown session' using errcode = '22023';
  end if;

  if v_status <> 'scheduled' or v_lock is null or now() >= v_lock then
    raise exception 'Predictions are closed for this session' using errcode = '55000';
  end if;

  if v_type = 'sprint' then
    if p_p4 is not null or p_p5 is not null or p_pole is not null or p_fastest_lap is not null then
      raise exception 'A sprint prediction has only three picks' using errcode = '22023';
    end if;
    if p_p1 is null or p_p2 is null or p_p3 is null then
      raise exception 'Pick all three positions' using errcode = '22023';
    end if;
    v_top := array[p_p1, p_p2, p_p3];
    v_all := v_top;
  else
    if p_p1 is null or p_p2 is null or p_p3 is null or p_p4 is null or p_p5 is null
       or p_pole is null or p_fastest_lap is null then
      raise exception 'All seven picks are required for a race' using errcode = '22023';
    end if;
    v_top := array[p_p1, p_p2, p_p3, p_p4, p_p5];
    v_all := v_top || array[p_pole, p_fastest_lap];
  end if;

  if (select count(distinct x) from unnest(v_top) as x) <> cardinality(v_top) then
    raise exception 'Each position needs a different driver' using errcode = '22023';
  end if;

  if (select count(*) from public.drivers d
      where d.id = any (v_all) and d.season = v_season and d.is_active)
     <> (select count(distinct x) from unnest(v_all) as x) then
    raise exception 'Unknown or inactive driver in your picks' using errcode = '22023';
  end if;

  insert into public.predictions
    (user_id, session_id, p1, p2, p3, p4, p5, pole, fastest_lap)
  values
    (v_user, p_session_id, p_p1, p_p2, p_p3, p_p4, p_p5, p_pole, p_fastest_lap)
  on conflict (user_id, session_id) do update set
    p1 = excluded.p1, p2 = excluded.p2, p3 = excluded.p3,
    p4 = excluded.p4, p5 = excluded.p5,
    pole = excluded.pole, fastest_lap = excluded.fastest_lap,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- Privileges ---------------------------------------------------------------

revoke all on public.predictions from anon, authenticated;
grant select on public.predictions to authenticated;

revoke all on function public.is_prediction_locked(text) from public, anon;
revoke all on function public.submit_prediction(text, text, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.is_prediction_locked(text) to authenticated;
grant execute on function public.submit_prediction(text, text, text, text, text, text, text, text)
  to authenticated;

-- Keep the public view consistent: closed unless the event is still scheduled.

create or replace view public.prediction_windows
with (security_invoker = true) as
select
  s.id           as session_id,
  s.event_id     as event_id,
  s.session_type as target_type,
  l.id           as lock_session_id,
  l.start_utc    as lock_at,
  (l.start_utc is not null and now() < l.start_utc and e.status = 'scheduled') as is_open
from public.sessions s
join public.events e on e.id = s.event_id
join public.sessions l
  on l.event_id = s.event_id
 and l.session_type = case s.session_type
                        when 'race'   then 'qualifying'
                        when 'sprint' then 'sprint_qualifying'
                      end
where s.session_type in ('race', 'sprint');
