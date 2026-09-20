-- Ttareungi (따릉이) OD sampling by hour of day for the particle trips
-- (src/data/odTrips.ts). Run once in the Supabase SQL Editor — the anon key cannot
-- run DDL. Supersedes bike_od_sampling.sql: same weighted-draw scheme, one extra
-- dimension. `hour` is the RENTAL hour, 0..23 local time. The dashboard's window is
-- half-open [hour_from, hour_to) in whole hours and never wraps midnight, so
-- (0, 24) reproduces the whole-day behaviour of the superseded file exactly.
--
-- Tables (uploaded by hand):
--   bike_rental_hourly (rent_station_no int, return_station_no int, hour int,
--                       trips int)                                     ~3.45M OD×hour rows
--   bike_station       (station_no int, station_id, station_name, district, lat, lon,
--                       rent_trips, return_trips)                        ~2.8k stations

-- Building the cum view sorts all 3.45M rows inside 24 window partitions, which
-- runs well past the SQL Editor's default statement timeout on a small instance.
set statement_timeout = '600s';

-- 1. Read-only public access (already applied; kept here for the record).
-- alter table public.bike_rental_hourly enable row level security;
-- create policy "anon read" on public.bike_rental_hourly for select to anon using (true);

-- 2. Running total of trips per OD pair WITHIN each hour, so a uniform draw in
--    [0, total_of_that_hour) lands on a pair with probability ∝ trips. Same-station
--    round trips are excluded: they top the table (leisure loops) but have zero
--    straight-line length.
create materialized view if not exists public.bike_od_hourly_cum as
  select hour, rent_station_no as o, return_station_no as d,
         sum(trips) over (partition by hour order by rent_station_no, return_station_no) as cum
  from public.bike_rental_hourly
  where rent_station_no <> return_station_no and trips > 0 and hour between 0 and 23;

-- Deliberately NOT unique, unlike bike_od_sampling.sql: if the upload contains two
-- rows for the same (hour, o, d) they are ORDER BY peers, and the default RANGE
-- frame gives every peer the same running total — so `cum` repeats. The weights
-- stay correct (the last peer's cum still accounts for all of them, and the
-- `cum >= r order by cum limit 1` lookup picks the first peer of that step), but a
-- unique index would refuse to build.
create index if not exists bike_od_hourly_cum_idx on public.bike_od_hourly_cum (hour, cum);

-- 3. Per-hour weight of the whole hour. max(cum) rather than sum(trips): it is by
--    definition the running total's last value, i.e. exactly the upper edge the
--    draw below compares against.
create materialized view if not exists public.bike_od_hourly_totals as
  select hour, max(cum) as total
  from public.bike_od_hourly_cum
  group by hour;

create unique index if not exists bike_od_hourly_totals_idx on public.bike_od_hourly_totals (hour);

-- 4. n weighted draws with replacement, restricted to the [hour_from, hour_to)
--    window. One random number per draw does both jobs: laid end to end, the
--    window's ≤ 24 hour totals form one number line, so `r` first picks the hour
--    it falls in (walk the ≤ 24 cumulative totals) and then, minus everything
--    below that hour, the pair inside it. That composition is exactly ∝ trips
--    across the whole window — busy hours contribute proportionally more pairs.
create or replace function public.sample_bike_od_hourly(n int, hour_from int, hour_to int)
returns table (o int, d int)
language sql volatile security definer set search_path = public as $$
  with bounds as (
    -- Clamp, never wrap: lo in [0,23], hi in [lo+1, 24].
    select greatest(0, least(23, hour_from)) as lo,
           least(24, greatest(greatest(0, least(23, hour_from)) + 1, hour_to)) as hi
  ),
  hours as materialized (
    -- `below` = total weight of the window's hours before this one, so
    -- [below, below + total) is this hour's slice of the number line.
    select t.hour, t.total,
           coalesce(sum(t.total) over (order by t.hour
                    rows between unbounded preceding and 1 preceding), 0)::bigint as below
    from bike_od_hourly_totals t, bounds b
    where t.hour >= b.lo and t.hour < b.hi and t.total > 0
  ),
  span as (select coalesce(max(below + total), 0)::bigint as total from hours),
  draws as materialized (
    -- MATERIALIZED so random() is evaluated once per row and the SAME value feeds
    -- both laterals below; inlined, the planner would re-evaluate the volatile
    -- expression per reference and the hour and the pair would disagree. An empty
    -- window (span 0) yields no rows, and the function returns nothing.
    select floor(random() * (select total from span))::bigint + 1 as r
    from generate_series(1, least(n, 1000))
    where (select total from span) > 0
  )
  select s.o, s.d
  from draws
  cross join lateral (
    -- Which hour did r land in, and where inside it (rr in [1, total]).
    select h.hour, draws.r - h.below as rr from hours h
    where h.below + h.total >= draws.r order by h.hour limit 1
  ) p
  cross join lateral (
    -- r, cum and below are all bigint on purpose: sum(bigint) returns numeric, and
    -- comparing numeric to the bigint `cum` would cast the column and throw away
    -- the (hour, cum) index — the difference between an index scan and 3.45M rows.
    select c.o, c.d from bike_od_hourly_cum c
    where c.hour = p.hour and c.cum >= p.rr order by c.cum limit 1
  ) s
$$;

grant execute on function public.sample_bike_od_hourly(int, int, int) to anon;

-- 5. Verification only — not needed by the app. Same body, but it also returns the
--    hour each pair was drawn from, so the drawn hour mix can be compared with the
--    table's own weights.
-- create or replace function public.sample_bike_od_hourly_check(n int, hour_from int, hour_to int)
-- returns table (hour int, o int, d int)
-- language sql volatile security definer set search_path = public as $$
--   with bounds as (
--     select greatest(0, least(23, hour_from)) as lo,
--            least(24, greatest(greatest(0, least(23, hour_from)) + 1, hour_to)) as hi
--   ),
--   hours as materialized (
--     select t.hour, t.total,
--            coalesce(sum(t.total) over (order by t.hour
--                     rows between unbounded preceding and 1 preceding), 0)::bigint as below
--     from bike_od_hourly_totals t, bounds b
--     where t.hour >= b.lo and t.hour < b.hi and t.total > 0
--   ),
--   span as (select coalesce(max(below + total), 0)::bigint as total from hours),
--   draws as materialized (
--     select floor(random() * (select total from span))::bigint + 1 as r
--     from generate_series(1, least(n, 1000))
--     where (select total from span) > 0
--   )
--   select p.hour, s.o, s.d
--   from draws
--   cross join lateral (
--     select h.hour, draws.r - h.below as rr from hours h
--     where h.below + h.total >= draws.r order by h.hour limit 1
--   ) p
--   cross join lateral (
--     select c.o, c.d from bike_od_hourly_cum c
--     where c.hour = p.hour and c.cum >= p.rr order by c.cum limit 1
--   ) s
-- $$;
--
-- -- a. Drawn hour mix (should match b within sampling noise).
-- select hour, count(*) as drawn,
--        round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
-- from public.sample_bike_od_hourly_check(1000, 7, 10)
-- group by hour order by hour;
--
-- -- b. The table's own weights for the same window.
-- select hour, total,
--        round(100.0 * total / sum(total) over (), 1) as pct
-- from public.bike_od_hourly_totals
-- where hour >= 7 and hour < 10 order by hour;
--
-- drop function public.sample_bike_od_hourly_check(int, int, int);

-- After re-uploading bike_rental_hourly, refresh in this order (totals reads cum):
--   refresh materialized view public.bike_od_hourly_cum;
--   refresh materialized view public.bike_od_hourly_totals;

-- Plan B if the cum materialized view still times out: sort one hour at a time, so
-- Postgres never holds a 3.45M-row sort. Same rows, same semantics, plain tables.
--   create table public.bike_od_hourly_cum (hour int, o int, d int, cum bigint);
--   do $do$ begin
--     for h in 0..23 loop
--       insert into public.bike_od_hourly_cum (hour, o, d, cum)
--       select h, rent_station_no, return_station_no,
--              sum(trips) over (order by rent_station_no, return_station_no)
--       from public.bike_rental_hourly
--       where hour = h and rent_station_no <> return_station_no and trips > 0;
--     end loop;
--   end $do$;
--   create index on public.bike_od_hourly_cum (hour, cum);
--   create table public.bike_od_hourly_totals as
--     select hour, max(cum) as total from public.bike_od_hourly_cum group by hour;
--   create unique index on public.bike_od_hourly_totals (hour);
-- The function is unchanged — it never cares whether these are views or tables.
