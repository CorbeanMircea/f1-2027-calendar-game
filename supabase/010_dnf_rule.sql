-- 010: A driver cannot both finish in the top 8 and DNF.

-- 1) Remove saved race predictions that already break the rule (practice data only).
delete from public.predictions p
using public.sessions s
where s.id = p.session_id
  and s.session_type = 'race'
  and (p.picks ->> 'dnf_driver') is not null
  and (p.picks ->> 'dnf_driver') = any (public.jarr(p.picks, 'top8'));

-- 2) Rule functions.
create function public.prediction_dnf_ok(p_picks jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_picks ->> 'dnf_driver') is null
      or not ((p_picks ->> 'dnf_driver') = any (public.jarr(p_picks, 'top8')));
$$;

create function public.result_dnf_ok(p_data jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not exists (
    select 1
    from unnest(public.jarr(p_data, 'dnf_drivers')) as d
    where d = any (public.jarr(p_data, 'top8'))
  );
$$;

-- 3) Enforce the rule in the tables themselves.
alter table public.predictions
  add constraint predictions_dnf_not_in_top8 check (public.prediction_dnf_ok(picks));

alter table public.results
  add constraint results_dnf_not_in_top8 check (public.result_dnf_ok(data));

-- 4) Privileges for the helper functions.
revoke all on function public.prediction_dnf_ok(jsonb) from public, anon, authenticated;
revoke all on function public.result_dnf_ok(jsonb)     from public, anon, authenticated;
grant execute on function public.prediction_dnf_ok(jsonb) to service_role;
grant execute on function public.result_dnf_ok(jsonb)     to service_role;
