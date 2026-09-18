-- Ttareungi (따릉이) OD sampling for the particle trips (src/data/bikeTrips.ts).
-- Run once in the Supabase SQL Editor — the anon key cannot run DDL.
--
-- Tables (uploaded by hand):
--   bike_rental  (rent_station_no int, return_station_no int, trips int)   ~928k OD pairs
--   bike_station (station_no int, station_id, station_name, district, lat, lon,
--                 rent_trips, return_trips)                                 ~2.8k stations

-- 1. Read-only public access (already applied; kept here for the record).
-- alter table public.bike_station enable row level security;
-- alter table public.bike_rental  enable row level security;
-- create policy "anon read" on public.bike_station for select to anon using (true);
-- create policy "anon read" on public.bike_rental  for select to anon using (true);

-- 2. Running total of trips per OD pair, so a uniform draw in [0, total) lands on
--    a pair with probability ∝ trips. Same-station round trips are excluded: they
--    top the table (leisure loops) but have zero straight-line length.
create materialized view if not exists public.bike_od_cum as
  select rent_station_no as o, return_station_no as d,
         sum(trips) over (order by rent_station_no, return_station_no) as cum
  from public.bike_rental
  where rent_station_no <> return_station_no and trips > 0;

create unique index if not exists bike_od_cum_cum_idx on public.bike_od_cum (cum);

-- 3. n weighted draws with replacement. `r` is generated in the outer query and
--    correlated into the lateral so random() is re-evaluated per row; it is a
--    bigint in [1, total] like `cum`, so the lookup stays an index scan.
create or replace function public.sample_bike_od(n int)
returns table (o int, d int)
language sql volatile security definer set search_path = public as $$
  select s.o, s.d
  from (select floor(random() * (select max(cum) from bike_od_cum))::bigint + 1 as r
        from generate_series(1, least(n, 1000))) t
  cross join lateral (
    select o, d from bike_od_cum where cum >= t.r order by cum limit 1
  ) s
$$;

grant execute on function public.sample_bike_od(int) to anon;

-- After re-uploading bike_rental: refresh materialized view public.bike_od_cum;
