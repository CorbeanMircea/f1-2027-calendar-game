-- 003: Profiles, groups, group membership, and the invite-code join function.
-- Every table: RLS on, explicit grants, no direct writes from the website.

-- Tables ---------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 30),
  created_at   timestamptz not null default now()
);
create unique index profiles_display_name_lower_key
  on public.profiles (lower(display_name));

create table public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  invite_code  text not null unique,
  created_at   timestamptz not null default now()
);

create table public.group_members (
  group_id   uuid not null references public.groups (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'member' check (role in ('member', 'admin')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

alter table public.profiles      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;

-- Helper functions (SECURITY DEFINER avoids recursive policy checks) -----

create function public.is_group_member(p_group_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$;

create function public.shares_group_with(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.group_members me
    join public.group_members other on other.group_id = me.group_id
    where me.user_id = auth.uid() and other.user_id = p_user_id
  );
$$;

-- Join function: the ONLY way to become a member ------------------------

create function public.join_group(p_invite_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_code  text := upper(regexp_replace(coalesce(p_invite_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_group uuid;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 30 then
    raise exception 'Display name must be 2 to 30 characters' using errcode = '22023';
  end if;

  select id into v_group from public.groups where invite_code = v_code;
  if v_group is null then
    raise exception 'Invalid invite code' using errcode = '22023';
  end if;

  insert into public.profiles (id, display_name)
  values (v_user, v_name)
  on conflict (id) do update set display_name = excluded.display_name;

  insert into public.group_members (group_id, user_id)
  values (v_group, v_user)
  on conflict do nothing;

  return v_group;
exception
  when unique_violation then
    raise exception 'That display name is already taken' using errcode = '22023';
end;
$$;

-- Policies --------------------------------------------------------------

create policy "members can read their groups"
  on public.groups for select to authenticated
  using (public.is_group_member(id));

create policy "members can read group membership"
  on public.group_members for select to authenticated
  using (public.is_group_member(group_id));

create policy "read own or group-mate profiles"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_group_with(id));

-- Privileges: start from nothing, grant only what is needed ---------------

revoke all on public.profiles, public.groups, public.group_members
  from anon, authenticated;

grant select on public.profiles      to authenticated;
grant select on public.group_members to authenticated;
-- The invite_code column is deliberately NOT readable through the API.
grant select (id, name, created_at) on public.groups to authenticated;

revoke all on function public.is_group_member(uuid)    from public, anon;
revoke all on function public.shares_group_with(uuid)  from public, anon;
revoke all on function public.join_group(text, text)   from public, anon;

grant execute on function public.is_group_member(uuid)   to authenticated;
grant execute on function public.shares_group_with(uuid) to authenticated;
grant execute on function public.join_group(text, text)  to authenticated;
