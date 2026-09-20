# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Urban Flow** — a data-visualization website about Seoul (서울). Seoul data is rendered as
**contour-line terrain** (등고선) with **GPU particles flowing over it**, plus an interactive
**comparison dashboard** that starts with one panel and grows to **up to 6** as the user adds
datasets (duplicates allowed once all seven are shown). Seven **real** datasets: Elevation
(DEM, rasterized from 20 m elevation contour lines) · Temperature (기온) · Noise (소음) ·
Humidity (습도) — 2023 yearly medians from the S-DoT sensor network — · Population (인구) ·
Businesses (사업체) · Workers (종사자) — 통계청 SGIS 2024 100 m grid counts, summed per 250 m
cell. No time-of-day dimension in any of them. The earlier
synthetic datasets (따릉이, 생활이동, 지하철 승하차, 생활인구, floor-area densities) are
**parked** — hidden from `SOURCES`, adapters and JSONs kept on disk — until real data exists.
The global particle budget is split across active panels (`src/layers/particleBudget.ts`).

Architecture is based on the experimental repo `Aete/seoul-terrain-animation` (referenced,
not forked — its data/heightmap/contour pipeline and shaders are the template; its particle
system was never built, so we implement that ourselves).

Page structure: **Hero → About → Dashboard**. UI copy is English; code identifiers English.
(Dataset names may keep their Korean originals in parentheses, e.g. "Temperature (기온)".)

## Commands

- `npm run dev` — dev server (Vite, default port 5173)
- `npm run build` — `tsc -b && vite build`
- `npm run typecheck` — `tsc -b --noEmit`
- `npm run lint` — **oxlint** (not eslint)

No test runner. Verify each increment **visually**: run the dev server and screenshot with
Playwright (`npm i -D playwright && npx playwright install chromium`, then a short
`chromium.launch` script) — this is the project's verification loop, not unit tests.

## Architecture

Visualization pipeline: **data adapter → KDE heightmap → contour shader → GPU particles**,
rendered by deck.gl. The whole pipeline depends only on the generic `GeoPoint` model
(`src/data/types.ts`), never on dataset-specific fields — new datasets plug in as a
`DataSource` adapter under `src/data/sources/` (dir added in P2).

Particles are **trip players**, not flow-field walkers: each particle slot plays one `Trip`
`{ origin, destination, durationSec }` (`src/data/trips.ts`) as a straight line over the
terrain, then takes the next one from a `TripSource` via a prefetching `TripQueue`
(`src/layers/tripQueue.ts`, batched requests). The CPU predicts each trip's end from
`startAt + duration` — no GPU readback — and rewrites only that slot.

That slot bookkeeping (which trip, since when, on which clock) lives in a **shared
`TripSchedule`** (`src/layers/tripSchedule.ts`), not in the layer: every panel at the same
speed / time-scale gets the same schedule object (`sharedTripSchedule`), and each
`ParticleLayer` only mirrors it into its own GPU buffers. So all panels show **identical
particles in lockstep** — a panel added later joins mid-flight — and only the terrain under
them differs, which is what makes panels comparable. The clock advances only while some layer
ticks it, so it freezes when every panel is paused. Keep per-panel state out of particle motion.

Two deck.gl / luma.gl 9.3 traps in `ParticleLayer` (both were silent bugs):
- **GPU state belongs in the layer's `parameters` prop** (set in `defaultProps`), not the
  `Model`'s — deck calls `model.setParameters(layer parameters)` on every draw and wipes the
  Model's own. With deck's defaults the sprites alpha-blend and *write depth*, so a trail's
  near-transparent quad hides particles passing behind it (they blink crossing trails).
- **`encoder.finish()` does not run anything** — copies execute on
  `device.submit(encoder.finish())`. Without the submit the trail history never filled and
  trails were invisible.

Trips are **real OD pairs** from Supabase (`src/data/odTrips.ts`, the only file that knows the
schema). Two flows (`FLOWS`), drawn **at the same time** as separate color-coded particle
layers; the dashboard-wide toolbar gives each an on/off toggle (its swatch doubles as the
legend). Particles are a fixed **250 per flow per panel** (`PARTICLES_PER_FLOW`; `?tune` can override
it), all the same size — no per-particle size variation. Each flow's toolbar row also
carries its own **time-of-day range slider** (`src/ui/RangeSlider.tsx` — two thumbs, whole
hours, half-open `[from, to)`, no wrap past midnight, default **07–10**) choosing which
hours that flow's OD pairs are drawn from — per flow, but the same for every panel:
- **bike** — Ttareungi (따릉이): `bike_rental_hourly` ~3.45M `(rent_station_no,
  return_station_no, hour, trips)` rows + `bike_station` coordinates. Near-white.
- **migration** — living migration (생활이동): `living_migration_hourly` ~1.54M
  `(o_admdong_cd, d_admdong_cd, hour, trips)` rows + `living_migration_adm_dong` centroids
  (426 dongs). Yellow. Endpoints are pinned to the dong centroid by default
  (`DEFAULT_SCATTER_SCALE = 0`, a user decision — flows read as clean centroid-to-centroid
  lines); the `?tune` "migration scatter" knob (`setOdScatterScale`) spreads them over a disc
  of that × half the nearest-centroid distance.

Pairs are drawn **∝ trips within the selected hour window** server-side by one RPC per flow,
`sample_*_hourly(n, hour_from, hour_to)` (`supabase/*_hourly_sampling.sql`, run by hand in the
SQL Editor: a per-hour cumulative-weight materialized view + a 24-row totals view, one random
`r` per draw picking both the hour and the pair; same-place pairs excluded; the pre-hourly
`supabase/*_sampling.sql` stay on disk, superseded). One page-wide reservoir per **(flow, hour
window)** — LRU of 6 windows, places paginated once per flow, one 60 s rotating-refresh timer
per flow — so request volume does not grow with panel count. **Each flow's hour window is
page-wide module state in `odTrips.ts` (`setOdHourRange(flowId, …)`) and deliberately NOT
part of the `sharedTripSchedule` key**: re-keying would tear down every `ParticleLayer` and
blank the swarm. Instead the dashboard calls `flushSharedTripSchedules('<flow>|')`, which
drops only that flow's prefetched trips — particles in flight finish their trip and the next ones come from the new
hours. Duration = distance / the panel's speed knob ×
the flow's `speedScale` — there is no travel-time data. Needs `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` (`.env.local`, and Vercel env); without them, or on any failure, the
default-on flow falls back to `randomTripSource` and the other just doesn't draw. Only living
migration is on when the dashboard loads (`defaultOn` in `FLOWS`); bike is one click away. The console
gets one `[urban-flow] Supabase (<flow>): …` status line per flow per page load (later hour
windows log at `console.debug`). A trip source must never reject — `TripQueue` retries a
rejecting source forever; an empty batch parks it for good — so an hour window that fails to
load after a successful connect keeps the previous window's reservoir playing.

*Measured* scalar fields (DEM, S-DoT sensors) must be preprocessed onto a **complete regular
grid** (`scripts/preprocess/contours.ts`, `scripts/preprocess/sensors.ts`) — the runtime KDE
is a density sum, so raw sample points would render sensor density, not the measured value.
*Count* fields (population, businesses, workers) are the KDE's native case: cell weight = count, absent
cell = 0, so they go straight through `aggregateToGrid('sum')` with no fill or padding. Any
SGIS 100 m grid drops in via `scripts/preprocess/sgisGrid.ts` (`readSgisGrid(path, valueProp)`
+ a 5-line job under `datasets/`). Raw inputs in EPSG:5179 (UTM-K, the usual Korean national
grid) are reprojected with `scripts/preprocess/proj.ts` (proj4, dev-only).

- `src/data/types.ts` — `GeoPoint`, `DataSource`, `DatasetId`, `Bounds`. The contract every
  layer depends on. Datasets are source-agnostic weighted geopoints (+ optional `weightByHour`
  length-24 for the time-of-day scrubber).
- `src/config.ts` — Seoul `INITIAL_VIEW_STATE` (pitch 60, the "contour poster" look),
  `SEOUL_BOUNDS`, `BG_COLOR`. No basemap — deck.gl renders on the plain dark canvas.
- `src/sections/` — landing sections (`Hero`, `About`). `src/ui/` — shared Carbon primitives
  (`Button`, `layout` = Container/Section/Eyebrow, `TopNav`, `Footer`). `src/App.tsx` composes them.

## Conventions

- React 19, TypeScript 6 `strict` + `verbatimModuleSyntax` (**use `import type`** for type-only
  imports), `noUnusedLocals`/`noUnusedParameters` on. Vite, deck.gl 9.
- **CSS Modules** (`*.module.css`) per component, colors/spacing/type via CSS custom properties.
- GLSL (`.glsl/.vs/.fs/.vert/.frag`) imports as strings; decls in `src/vite-env.d.ts`.

## Design system — IBM Carbon, Gray 100 dark theme

`DESIGN-ibm.md` is the source spec; its "Urban Flow — Gray 100 Dark Theme" appendix is the
active theme. Live tokens are in **`src/styles/tokens.css`** (CSS custom properties) — the
implementation source of truth. Rules that are easy to violate:

- **Flat 0px corners** everywhere. Hierarchy from surface steps (`--bg` → `--layer-01` →
  `--layer-02`) + 1px `--border-subtle` hairlines — **never drop shadows**.
- **IBM Plex Sans / Plex Sans KR**, weight **300** for display sizes (42px+) — do not bold
  headlines. Body weight 400 with `letter-spacing: 0.16px`.
  - **Exception:** the Hero "Urban Flow" wordmark headline (`src/sections/Hero.module.css`
    `.headline`) is intentionally set to weight **700** — a deliberate departure from the
    display-300 rule for the site's opening statement. It is the only bold display headline.
- **One accent, IBM Blue** for the site chrome. On dark, links/interactive text use `--link`
  Blue 40 (`#78a9ff`); the primary button keeps Blue 60 (`#0f62fe`). No second brand color.
  - **Exception:** the contour terrain itself is the data encoding, so it carries its own
    ramp — low `#80fff6` (cyan) → peak `#ff0000` (red), `DEFAULT_CONTROLS` in
    `src/sections/TerrainPanel.tsx` — and particles are color-coded per flow (`FLOWS` in
    `src/data/odTrips.ts`): bike near-white `#f4f4f4`, living migration Carbon Yellow 30
    `#f1c21b`, both legible on either end of the ramp. These are deliberate user decisions
    (Sept 2026); keep chrome colors out of it.
- The visualization canvas sits directly on `--bg` `#161616` — one continuous dark surface
  with the site chrome.

## Git / branching

- **All work happens on a `features/<name>` branch** — never commit directly to `main` or
  `deploy`. Use a short, kebab-case description, e.g. `features/hero-layout`,
  `features/data-layer`. One branch per unit of work.
- **`deploy`** is the production branch (Vercel deploys from it). **`main`** is the base
  branch. Merge a `features/*` branch in only after it is visually verified.
- Keep commits scoped and descriptive; push the feature branch, then fast-forward `deploy`
  when the change is ready to ship.

## Working style

Build in incremental, **visually-verified** steps. Staged plan:
- **P0** bootstrap · **P1** landing shell (Hero/About/nav) — ✅ done & verified
- **P2** data layer · **P3** contour terrain · **P4** GPU particles — ✅ done & verified
- **P5** dashboard (1→6 panels) · **P6** polish + deploy

Next: **P5 dashboard growth**, then polish + deploy.
