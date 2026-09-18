-- Seoul living migration (생활이동) OD sampling for the particle trips
-- (src/data/odTrips.ts). Run once in the Supabase SQL Editor — the anon key cannot
-- run DDL. Same scheme as bike_od_sampling.sql.
--
-- Tables (uploaded by hand):
--   living_migration          (o_admdong_cd, d_admdong_cd, trips float)      ~179k OD pairs
--   living_migration_adm_dong (admdong_cd, sgis_adm_cd, sgg_nm, admdong_nm,
--                              lat, lon, out_trips, in_trips)                 426 dongs

-- 1. Read-only public access (already applied; kept here for the record).
-- alter table public.living_migration_adm_dong enable row level security;
-- create policy "anon read" on public.living_migration_adm_dong for select to anon using (true);

-- 2. Running total of trips per OD pair, so a uniform draw in [0, total) lands on
--    a pair with probability ∝ trips. Movement inside one dong is excluded: it is
--    a large share of all trips but has no direction to draw between two centroids.
create materialized view if not exists public.living_migration_cum as
  select o_admdong_cd::int as o, d_admdong_cd::int as d,
         sum(trips::double precision) over (order by o_admdong_cd, d_admdong_cd) as cum
  from public.living_migration
  where o_admdong_cd <> d_admdong_cd and trips > 0;

create index if not exists living_migration_cum_cum_idx on public.living_migration_cum (cum);

-- 3. n weighted draws with replacement. `r` is generated in the outer query and
--    correlated into the lateral so random() is re-evaluated per row; it is a
--    double like `cum` (trips are fractional estimates), so the lookup stays an
--    index scan.
create or replace function public.sample_living_migration(n int)
returns table (o int, d int)
language sql volatile security definer set search_path = public as $$
  select s.o, s.d
  from (select random() * (select max(cum) from living_migration_cum) as r
        from generate_series(1, least(n, 1000))) t
  cross join lateral (
    select o, d from living_migration_cum where cum >= t.r order by cum limit 1
  ) s
$$;

grant execute on function public.sample_living_migration(int) to anon;

-- After re-uploading living_migration: refresh materialized view public.living_migration_cum;
