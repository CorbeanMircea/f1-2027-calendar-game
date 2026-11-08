-- 027: Admin season overview: the players without picks now come with their user id.
-- One function re-created; nothing else changes. Run once in the Supabase SQL Editor, after 026.
--
-- To undo: run the admin_season_overview() part of 026 again.

-- Same function as in 026, with one change: "missing" now lists {user_id, name} for each player without picks,
-- so the admin screen can set picks for them.
create or replace function public.admin_season_overview()
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

  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.season desc)
    from (
      select
        w.season,
        w.lock_at,
        w.late_lock_at,
        (w.lock_at is not null and not w.is_open and not w.late_open) as closed,
        (select count(*) from public.season_predictions sp where sp.season = w.season) as picks_count,
        coalesce((
          select jsonb_agg(jsonb_build_object(
                   'user_id', sp.user_id, 'name', pf.display_name,
                   'drivers_pick', sp.drivers_pick, 'constructors_pick', sp.constructors_pick,
                   'half_value', sp.half_value, 'points', ss.points)
                 order by pf.display_name)
          from public.season_predictions sp
          join public.profiles pf on pf.id = sp.user_id
          left join public.season_scores ss on ss.user_id = sp.user_id and ss.season = sp.season
          where sp.season = w.season
        ), '[]'::jsonb) as picks,
        coalesce((
          select jsonb_agg(jsonb_build_object('user_id', pf.id, 'name', pf.display_name) order by pf.display_name)
          from public.group_members gm
          join public.profiles pf on pf.id = gm.user_id
          where not exists (
            select 1 from public.season_predictions sp where sp.user_id = gm.user_id and sp.season = w.season
          )
        ), '[]'::jsonb) as missing,
        (
          select to_jsonb(p) from (
            select r.id, r.version, r.drivers_top3 as drivers, r.constructors_top3 as teams, r.entered_at,
                   coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'name', pf.display_name,
                              'points', (public.calc_season_points(sp.drivers_pick, sp.constructors_pick, sp.half_value,
                                                                   r.drivers_top3, r.constructors_top3) ->> 'total')::integer)
                            order by pf.display_name)
                     from public.season_predictions sp
                     join public.profiles pf on pf.id = sp.user_id
                     where sp.season = w.season
                   ), '[]'::jsonb) as preview
            from public.season_results r
            where r.season = w.season and r.status = 'pending'
            order by r.version desc
            limit 1
          ) p
        ) as pending,
        (
          select to_jsonb(a) from (
            select r.id, r.version, r.drivers_top3 as drivers, r.constructors_top3 as teams, r.approved_at,
                   (select pf.display_name from public.profiles pf where pf.id = r.approved_by) as approved_by_name
            from public.season_results r
            where r.season = w.season and r.status = 'approved'
          ) a
        ) as approved
      from public.season_prediction_windows w
      where exists (select 1 from public.season_predictions sp where sp.season = w.season)
         or exists (select 1 from public.season_results r where r.season = w.season)
    ) x
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_season_overview() from public, anon;
grant execute on function public.admin_season_overview() to authenticated;

notify pgrst, 'reload schema';