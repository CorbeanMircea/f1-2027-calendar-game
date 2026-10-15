-- 011: A driver's external (results API) id must be unique per season, not globally.
alter table public.drivers drop constraint if exists drivers_external_id_key;
alter table public.drivers add constraint drivers_season_external_id_key unique (season, external_id);
