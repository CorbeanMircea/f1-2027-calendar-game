-- 019: Player avatars and lifetime XP.
-- Additive only: one new column, one new function, one new view.
-- Nothing existing is changed or removed. Safe to run once in the Supabase SQL editor.
--
-- To undo:
--   drop view if exists public.player_xp;
--   drop function if exists public.set_avatar(text);
--   alter table public.profiles drop column if exists avatar;

-- Avatar code, for example p3-c5-n27 = pattern 3, colour 5, number 27 ---------------------
alter table public.profiles add column if not exists avatar text;

alter table public.profiles drop constraint if exists profiles_avatar_format;
alter table public.profiles add constraint profiles_avatar_format
  check (avatar is null or avatar ~ '^p([0-9]|1[01])-c[0-7]-n([1-9]|[1-9][0-9])$');

-- Players choose their own avatar through this function. The website cannot write to
-- profiles directly (no UPDATE privilege), exactly like display names.
create or replace function public.set_avatar(p_avatar text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if p_avatar is null or p_avatar !~ '^p([0-9]|1[01])-c[0-7]-n([1-9]|[1-9][0-9])$' then
    raise exception 'Invalid avatar' using errcode = '22023';
  end if;
  update public.profiles set avatar = p_avatar where id = v_user;
  if not found then
    raise exception 'Join the friends group before choosing an avatar' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.set_avatar(text) from public, anon;
grant execute on function public.set_avatar(text) to authenticated;

-- XP = lifetime points across all seasons. Level and rank are worked out in the website.
-- security_invoker: each viewer only sees themselves and their group-mates, as with scores.
create or replace view public.player_xp
with (security_invoker = true) as
select
  p.id                              as user_id,
  p.display_name,
  p.avatar,
  coalesce(sum(sc.points), 0)::integer as xp,
  count(sc.session_id)::integer     as sessions_scored,
  coalesce(max(sc.points), 0)::integer as best_session
from public.profiles p
left join public.scores sc on sc.user_id = p.id
group by p.id, p.display_name, p.avatar;

revoke all on public.player_xp from anon, authenticated;
grant select on public.player_xp to authenticated;

-- Make the API pick up the new column, function and view straight away.
notify pgrst, 'reload schema';
