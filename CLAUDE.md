# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Urban Flow** — a data-visualization website about Seoul (서울). Seoul data is rendered as
**contour-line terrain** (등고선) with **GPU particles flowing over it**, plus an interactive
**comparison dashboard** that starts with one panel and grows to **up to 6** as the user adds
datasets (duplicates allowed once all are shown). Three datasets: 따릉이 (public bike) ·
생활이동 (population OD) · 지하철 승하차. The global particle budget is split across active
panels (`src/layers/particleBudget.ts`).

Architecture is based on the experimental repo `Aete/seoul-terrain-animation` (referenced,
not forked — its data/heightmap/contour pipeline and shaders are the template; its particle
system was never built, so we implement that ourselves).

Page structure: **Hero → About → Dashboard**. UI copy is English; code identifiers English.
(Dataset names may keep their Korean originals in parentheses, e.g. "Ttareungi (public bike)".)

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
- **One accent, IBM Blue.** On dark, links/interactive text use `--link` Blue 40 (`#78a9ff`);
  the primary button keeps Blue 60 (`#0f62fe`). No second brand color.
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
