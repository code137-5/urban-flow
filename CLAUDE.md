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
The global particle budget is split across active (panel, flow) layers
(`src/layers/particleBudget.ts`, `activeLayers`).

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
- `npm run shot -- <phase>` — the visual-verification harness (`scripts/shot.mjs`)

No test runner. Verify each increment **visually**: with `npm run dev` running, drive
`npm run shot -- <phase>` (Playwright + SwiftShader; screenshots and a JSON report land in
the gitignored `.preview/`). This is the project's verification loop, not unit tests.
Phases: `layout` `overflow` `state` `keys` `pointer` `disabled` `noblank` `panels` `perpanel`
`perflow` `bike` `volume` `tune` — plus `--flow bike|migration`, `--width N`, `--preset` for `tune`
(its `count`/`trend` presets set trips-per-particle through the panel's number input — there is
no `?tune` knob for it). `perpanel` checks per-panel settings: a new panel copies the previous
one, different windows give different densities, identical settings stay in lockstep. It carries
the fixtures that are tedious to rebuild: a PNG→RGBA `analyze()` that counts particle pixels
per flow, a `boot()` capturing console / pageerror / failed-request / Supabase-RPC channels,
and `[class*=]` selectors for the hashed CSS Module classnames. **Add a phase there** rather
than starting a new one-off script — the root `.shot-*.mjs` pattern stays gitignored.

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
`TripSchedule`** (`src/layers/tripSchedule.ts`), not in the layer; each `ParticleLayer` only
mirrors it into its own GPU buffers. Schedules are keyed
`${flow}|${from}-${to}|${speed}|${timeScale}` (`sharedTripSchedule`): panels with identical
settings get the same schedule object and show **identical particles in lockstep** — a panel
added later joins mid-flight — so only the terrain under them differs, which is what makes
panels comparable; a panel with its own hour window (or speed) runs its own schedule.
Trips-per-particle is not in the key: panels differing only there share a schedule and each
plays its first N slots (`ensure` never shrinks). The registry is refcounted — `TerrainPanel`
holds its keys from an effect (`retainTripSchedule` / `releaseTripSchedule`; effects balance
under StrictMode, memos don't), and a schedule nobody holds is `dispose()`d (queue + source,
which releases its reservoir lease) after `SCHEDULE_GRACE_MS` (1 s). The clock advances only
while some layer ticks it, so it freezes when every panel is paused.

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
layers, with settings **per panel**: each panel's control strip
(`src/sections/PanelControls.tsx`, between the panel header and its canvas) gives each flow an
on/off toggle (its swatch doubles as the legend), its own **time-of-day range slider**
(`src/ui/RangeSlider.tsx` — two thumbs, whole hours, half-open `[from, to)`, no wrap past
midnight, default **07–10**, double-click resets that panel's flow; the row debounces the
thumbs 200 ms, so only committed hours leave it) choosing which hours that flow's OD pairs are
drawn from, and a "1 particle ≈ [n] trips" number input (`src/ui/NumberInput.tsx` — step 500,
1,000–100,000, commits on blur / Enter / ↑↓ / steppers; Escape or garbage reverts). Without
Supabase the sliders and inputs are disabled; the toggle stays live. The committed values live
in `PanelDescriptor.flows` in `Dashboard.tsx` (types, `DEFAULT_PANEL_FLOWS` and
`resolvePanelFlows` in `src/sections/panelSettings.ts`), and a new panel **copies the previous
panel's settings**, so it joins that panel's swarm mid-flight. The dashboard-wide toolbar holds
only "Sync all views to panel 1" and the no-Supabase hint. The **particle count is ∝ the trips
in the panel's hour window** (a user decision): `particles = sum of the window's hourly totals ÷
that panel's tripsPerParticle`, so 02–05 draws ~30 and 00–24 ~1,900 where 07–10 draws ~400.
`FLOWS.tripsPerParticle` (bike 15,000, migration 8,000 — the datasets count in different units,
and these give ~400 each at 07–10) are only the **defaults**; the `?tune` trips-per-particle
knobs are gone. The totals are the same 24-row `*_hourly_totals` views the sampling RPCs weight
by, loaded page-wide for both flows on mount (`loadOdHourTotals`). Until they load — and for
good without Supabase — the count is the fallback `PARTICLES_PER_FLOW` (400); either way it is
then capped by the layer's share of the global budget. A count change rebuilds that
`ParticleLayer` (briefly blank, trails restart) while its schedule and the trips in flight carry
on; slots added to an existing swarm depart staggered from their origins
(`TripSchedule.ensure`). Particles are all the same size — no per-particle size variation.
- **bike** — Ttareungi (따릉이): `bike_rental_hourly` ~3.45M `(rent_station_no,
  return_station_no, hour, trips)` rows + `bike_station` coordinates. Near-white.
- **migration** — living migration (생활이동): `living_migration_hourly` ~1.54M
  `(o_admdong_cd, d_admdong_cd, hour, trips)` rows + the 426 dong representative points
  shipped **static** in `public/data/living-migration-dongs.json` (`{ id, lat, lon }[]`, 행안부
  `admdong_cd`; built by `particle-generator/notebooks/living_migration_od.ipynb` — the
  `living_migration_adm_dong` table was dropped, a user decision). Yellow. Endpoints are
  pinned to the dong centroid by default
  (`DEFAULT_SCATTER_SCALE = 0`, a user decision — flows read as clean centroid-to-centroid
  lines); the `?tune` "migration scatter" knob (`setOdScatterScale`) spreads them over a disc
  of that × half the nearest-centroid distance.

Pairs are drawn **∝ trips within the selected hour window** server-side by one RPC per flow,
`sample_*_hourly(n, hour_from, hour_to)` (`supabase/*_hourly_sampling.sql`, run by hand in the
SQL Editor: a per-hour cumulative-weight materialized view + a 24-row totals view, one random
`r` per draw picking both the hour and the pair; same-place pairs excluded; the pre-hourly
`supabase/*_sampling.sql` stay on disk, superseded). A trip source is built for one fixed
window — `odTripSource(flow, { range, … })` — and the window is in the schedule key, so **a
window change is a new key → a new schedule → a rebuilt `ParticleLayer`**, not an in-place
reset (`reset()` / `epoch` / `setOdHourRange` / `resetSharedTripSchedules` no longer exist):
that panel's flow blanks until the window's reservoir lands, then the swarm appears already
mid-flight (`ensure`'s head start for a fresh schedule) — the screen never mixes two windows.
One page-wide reservoir per **(flow, hour window)**, places paginated once per flow; reservoirs
sit in an LRU of 6 windows per flow that never evicts a leased one. A live source **leases**
its reservoir: pinned against eviction, one 60 s rotating-refresh timer per leased window (not
per source), released on `dispose()` — the entry then stays cached as an ordinary evictable
LRU item, so going back is instant. Request volume: the common case is unchanged (every panel
on the default windows shares one reservoir per flow that is on → 1 refresh RPC/min with only
living migration on, 2 with bike too); the worst case, 6 panels × 2
flows on distinct windows, is 60 sampling RPCs (5 batches per window) spread over interactions
plus 12 refresh RPC/min. (`flush()`, which lets trips in flight finish, remains for the `?tune`
scatter knob via `flushSharedTripSchedules`.) Duration = distance / the panel's speed knob ×
the flow's `speedScale` — there is no travel-time data. Needs `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` (`.env.local`, and Vercel env); without them, or when a flow never
connects, the default-on flow falls back to `randomTripSource` and the other just doesn't
draw. Only living migration is on when the dashboard loads (`defaultOn` in `FLOWS` →
`DEFAULT_PANEL_FLOWS`); bike is one click away. The console gets one `[urban-flow] Supabase
(<flow>): …` status line per flow per page load (later hour windows log at `console.debug`). A
trip source must never reject — `TripQueue` retries a rejecting source forever; an empty batch
parks it for good — so an hour window that fails to load after a successful connect resolves an
empty batch, which parks that panel's flow (blank until that panel changes something). The
cache key is dropped, and `sharedTripSchedule` replaces a parked schedule nobody holds with a
fresh one, so the next panel to ask for that window retries; a panel still holding the parked
key keeps it.

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
- `src/config.ts` — Seoul `INITIAL_VIEW_STATE` (top-down, north-up — a user decision; the
  panel's 2D/3D toggle tilts to the pitched "contour poster" look),
  `SEOUL_BOUNDS`, `BG_COLOR`. No basemap — deck.gl renders on the plain dark canvas.
- `src/sections/` — landing sections (`Hero`, `About`) and the dashboard: `Dashboard` (panel
  list, committed per-panel flow settings, hour totals, `activeLayers`), `PanelControls` (a
  panel's flow strip), `panelSettings` (types, defaults, `TPP_*` bounds, `resolvePanelFlows`),
  `TerrainPanel`. `src/ui/` — shared Carbon primitives (`Button`, `layout` =
  Container/Section/Eyebrow, `TopNav`, `Footer`, `RangeSlider`, `NumberInput`, `snap` =
  `snapClamp` shared by both). `src/App.tsx` composes them.

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
