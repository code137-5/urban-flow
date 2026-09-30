import type { SupabaseClient } from '@supabase/supabase-js'
import { SEOUL_BOUNDS } from './bounds'
import { getSupabase } from './supabase'
import { distanceMeters, mulberry32, offsetMeters } from './trips'
import type { Trip, TripSource } from './trips'

/**
 * Real particle trips: origin→destination pairs from Supabase, drawn with
 * probability ∝ their trip count. Two flows share the machinery:
 *
 * - `bike` — Ttareungi (따릉이, Seoul public bike) station-to-station rentals.
 * - `migration` — Seoul living migration (생활이동), movement between
 *   administrative dongs (행정동).
 *
 * The OD tables are far too big to download (bike ~3.45M pair-hours), so the
 * weighted draw happens in Postgres (one `sample_*_hourly` RPC per flow, see
 * supabase/*_hourly_sampling.sql). To keep egress flat the page holds ONE shared
 * reservoir of weighted samples per (flow, hour window); every trip source on
 * that window draws uniformly from it (a uniform draw from a weighted sample is
 * still weighted). A small LRU of windows means going back to a window already
 * looked at costs nothing.
 *
 * Each panel chooses its own time-of-day window per flow — bike 07–10 beside
 * bike 17–20 is the point of the dashboard — so a trip source is built FOR one
 * (flow, window) (`OdTripOptions.range`) and the window is part of its schedule's
 * key (tripSchedule.ts): panels on the same window share one schedule and move in
 * lockstep, panels on different windows run their own. While a source is alive it
 * holds a LEASE on its reservoir: the entry is pinned in the LRU, and the first
 * lease on a window arms that window's one slow refresh timer, which rotates the
 * long tail of pairs through by overwriting the reservoir in place. The last
 * `dispose()` clears the timer and the entry becomes an ordinary evictable LRU
 * item, so re-selecting the window is instant.
 *
 * Request volume: the common case is unchanged — every panel on the default
 * windows shares one reservoir per flow that is on (one refresh RPC a minute
 * page-wide with only living migration on, two with bike on too). The worst
 * case, 6 panels × 2 flows on 12 distinct windows, is 12 refresh RPCs a minute
 * with ~60k legs resident; the 5-batch loads themselves only ever happen once per
 * window while it stays in the LRU.
 *
 * Places (station / dong coordinates) are hour-independent, so they are paginated
 * once per flow per page load and shared by every window.
 *
 * This file is the only place that knows the Supabase schema.
 */

/** Half-open time-of-day window [from, to) in whole clock hours. Never wraps past midnight. */
export type HourRange = readonly [from: number, to: number]

/** The morning peak — the window the dashboard opens on. */
export const DEFAULT_HOUR_RANGE: HourRange = [7, 10]

export type FlowId = 'bike' | 'migration'

export interface OdFlow {
  id: FlowId
  /** UI copy for the dashboard toggle. */
  label: string
  /** Default particle color — the flows are told apart by color alone. */
  color: string
  /**
   * Drawn when the dashboard first loads. Such a flow also falls back to random
   * trips when Supabase is unavailable, so the default view is never motionless.
   */
  defaultOn: boolean
  /**
   * Where the OD endpoints live — either a Supabase table with `id`, `lat`, `lon`
   * columns (paginated once), or a static JSON file of `{ id, lat, lon }[]` under
   * `public/` (a few hundred rows is not worth a table, a user decision).
   */
  places: { table: string; id: string } | { url: string }
  /**
   * `(n int, hour_from int, hour_to int) → { o, d }[]` place-id pairs drawn
   * ∝ trips within the half-open hour window, n ≤ 1000.
   */
  sampleRpc: string
  /**
   * `(hour int, total numeric)`, 24 rows: the weight of each hour — the very
   * totals `sampleRpc` draws against, so the particle count and the OD mix can
   * never disagree about what a window contains.
   */
  totalsTable: string
  /**
   * How many trips one particle stands for. Per flow, because the two datasets
   * count in different units (bike = accumulated rentals, migration = estimated
   * people) — the defaults are tuned so the 07–10 window draws ~400 of each.
   */
  tripsPerParticle: number
  /** What the totals count, for each panel's scale line: "1 particle ≈ 15,000 <unit>". */
  tripUnit: string
  /**
   * Places are area centroids, not points: scatter each endpoint around its
   * centroid so trips between two dongs don't all ride one identical line.
   */
  scatter: boolean
  /**
   * Multiplier on the panel's speed knob, which is tuned for cross-city random
   * trips (~10 km). Real trips are shorter — bike median ~1 km, migration ~3 km
   * — and the shortest would blink out in under a second at full speed.
   */
  speedScale: number
  /** Skip pairs closer than this — a particle that short just blinks in place. */
  minDistanceMeters: number
}

export const FLOWS: readonly OdFlow[] = [
  {
    id: 'bike',
    label: 'Bike trips (따릉이)',
    color: '#f4f4f4', // near-white — legible on both the cyan and the red end of the ramp
    defaultOn: false,
    places: { table: 'bike_station', id: 'station_no' },
    sampleRpc: 'sample_bike_od_hourly',
    totalsTable: 'bike_od_hourly_totals',
    tripsPerParticle: 15_000,
    tripUnit: 'trips',
    scatter: false,
    speedScale: 0.6,
    minDistanceMeters: 300,
  },
  {
    id: 'migration',
    label: 'Living migration (생활이동)',
    color: '#f1c21b', // Carbon Yellow 30 — the one hue far from cyan, red and white
    defaultOn: true,
    // 426 dong representative points (행안부 admdong_cd → lat/lon), built by
    // particle-generator/notebooks/living_migration_od.ipynb; shipped static.
    places: { url: `${import.meta.env.BASE_URL}data/living-migration-dongs.json` },
    sampleRpc: 'sample_living_migration_hourly',
    totalsTable: 'living_migration_hourly_totals',
    tripsPerParticle: 8_000,
    tripUnit: 'trips',
    scatter: true,
    speedScale: 0.6,
    minDistanceMeters: 300,
  },
]

export const FLOW_BY_ID = Object.fromEntries(FLOWS.map((f) => [f.id, f])) as Record<FlowId, OdFlow>

const PAGE_SIZE = 1000 // PostgREST max rows per request
const RESERVOIR_BATCHES = 5 // × PAGE_SIZE samples held in memory
const RESERVOIR_CACHE = 6 // hour windows kept per flow (LRU) — ~5k legs each
const REFRESH_MS = 60_000

/** Whole hours, `lo` in [0,23] and `hi` in [lo+1,24] — clamped, never wrapped. */
function clampHourRange(from: number, to: number): HourRange {
  const lo = Math.min(23, Math.max(0, Math.round(from)))
  return [lo, Math.min(24, Math.max(lo + 1, Math.round(to)))]
}

/**
 * Multiplier on every scattered place's disc radius (`OdFlow.scatter`): 1 is the
 * half-nearest-centroid disc, 0 pins each endpoint to its centroid so all trips
 * between two dongs ride one line. Page-wide — every panel scatters alike — and a
 * dev knob only (`?tune`); a change flushes the schedules' prefetch pools.
 *
 * Default 0 (user decision): dong-to-dong flows read as clean lines between
 * centroids rather than a haze, and the corridors that carry the most trips
 * brighten where their particles stack.
 */
export const DEFAULT_SCATTER_SCALE = 0
let scatterScale = DEFAULT_SCATTER_SCALE

/** Returns true only when the scale actually changed, so the caller knows to flush. */
export function setOdScatterScale(scale: number): boolean {
  const next = Math.max(0, scale)
  if (next === scatterScale) return false
  scatterScale = next
  return true
}

/**
 * Whether this build has Supabase credentials at all. False only when the
 * `VITE_SUPABASE_*` env vars are missing — it says nothing about whether the
 * tables answer, which is what the console status line reports.
 */
export async function odConfigured(): Promise<boolean> {
  return (await getSupabase()) !== null
}

/** An OD endpoint; `radius` > 0 means "somewhere within this far of `center`". */
interface Place {
  center: [number, number]
  radius: number
}

/** One sampled OD pair; endpoints and duration are resolved per draw. */
interface Leg {
  origin: Place
  destination: Place
}

type Places = Map<number, Place>

type PlaceRow = { id: number; lat: number; lon: number }

/** Every place row of the flow, from its table (paginated) or its static file. */
async function loadPlaceRows(client: SupabaseClient, flow: OdFlow): Promise<PlaceRow[]> {
  if ('url' in flow.places) {
    const res = await fetch(flow.places.url)
    if (!res.ok) throw new Error(`${flow.places.url}: ${res.status} ${res.statusText}`)
    return (await res.json()) as PlaceRow[]
  }
  const { table, id } = flow.places
  const rows: PlaceRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select(`id:${id}, lat, lon`)
      .order(id)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const page = data as unknown as PlaceRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

async function loadPlaces(client: SupabaseClient, flow: OdFlow): Promise<Places> {
  const [minLng, minLat, maxLng, maxLat] = SEOUL_BOUNDS
  const places: Places = new Map()
  for (const { id, lat, lon } of await loadPlaceRows(client, flow)) {
    // Trip endpoints are never clamped downstream (lngLatToUv), so a place
    // outside the bounds would draw its particle off the terrain.
    if (lon >= minLng && lon <= maxLng && lat >= minLat && lat <= maxLat) {
      places.set(id, { center: [lon, lat], radius: 0 })
    }
  }
  if (flow.scatter) {
    // No polygons or areas in the table, so size each dong by its spacing: half
    // the distance to the nearest other centroid (~400 m in Seoul).
    const all = [...places.values()]
    for (const place of all) {
      let nearest = Infinity
      for (const other of all) {
        if (other !== place) nearest = Math.min(nearest, distanceMeters(place.center, other.center))
      }
      place.radius = Number.isFinite(nearest) ? nearest / 2 : 0
    }
  }
  return places
}

async function sampleLegs(
  client: SupabaseClient,
  flow: OdFlow,
  places: Places,
  range: HourRange,
): Promise<Leg[]> {
  const { data, error } = await client.rpc(flow.sampleRpc, {
    n: PAGE_SIZE,
    hour_from: range[0],
    hour_to: range[1],
  })
  if (error) throw error
  const legs: Leg[] = []
  for (const { o, d } of data as { o: number; d: number }[]) {
    const origin = places.get(o)
    const destination = places.get(d)
    if (origin && destination) legs.push({ origin, destination })
  }
  return legs
}

/**
 * The live sources on one (flow, hour window): how many, and the window's one
 * refresh timer, which runs exactly while `refs` > 0.
 */
interface Lease {
  refs: number
  timer: ReturnType<typeof setInterval>
}

/** Everything the page keeps per flow. One instance, created on first use. */
interface FlowState {
  /** Endpoint coordinates — hour-independent, so paginated once and reused. */
  places: Promise<Places> | null
  /** Trips per hour of day (length 24), fetched once; resolves null when unavailable. */
  totals: Promise<number[] | null> | null
  /** Reservoir per hour window, keyed `${from}-${to}`, used as an LRU. */
  reservoirs: Map<string, Promise<Leg[] | null>>
  /** Windows some live source is sampling — pinned in the LRU, each with its refresh timer. */
  leases: Map<string, Lease>
  /** Whether this flow has already printed its one console status line. */
  announced: boolean
  /** Sticky: Supabase can't supply this flow at all this page load. */
  failed: boolean
}

const states = new Map<FlowId, FlowState>()

/**
 * Keyed by id, not by `OdFlow`, so the totals loader can create a flow's state
 * before anything has asked it for trips.
 */
function stateFor(flowId: FlowId): FlowState {
  let state = states.get(flowId)
  if (!state) {
    state = {
      places: null,
      totals: null,
      reservoirs: new Map(),
      leases: new Map(),
      announced: false,
      failed: false,
    }
    states.set(flowId, state)
  }
  return state
}

const rangeKey = (range: HourRange): string => `${range[0]}-${range[1]}`

/**
 * The flow's places, paginated once. On failure the promise is dropped rather
 * than cached, so one flaky request doesn't poison every later hour window.
 */
function placesFor(state: FlowState, client: SupabaseClient, flow: OdFlow): Promise<Places> {
  if (!state.places) {
    const loading = (async () => {
      const places = await loadPlaces(client, flow)
      // An RLS-blocked table answers 200 with zero rows, not an error.
      if (places.size === 0) {
        const where = 'url' in flow.places ? flow.places.url : `${flow.places.table} (RLS policy?)`
        throw new Error(`${where} returned no places`)
      }
      return places
    })()
    state.places = loading
    loading.catch(() => {
      if (state.places === loading) state.places = null
    })
  }
  return state.places
}

/**
 * Trips per hour of day for one flow — 24 numbers, one request per flow per page
 * load. Never rejects: `null` means the count can't be derived (no Supabase env,
 * the view is unreadable, or it answered empty) and the caller keeps its fixed
 * fallback count. A failure is not cached, so a later call retries.
 */
export function loadOdHourTotals(flowId: FlowId): Promise<number[] | null> {
  const state = stateFor(flowId)
  if (!state.totals) {
    const flow = FLOW_BY_ID[flowId]
    const loading: Promise<number[] | null> = (async () => {
      // Off the synchronous path, so a failure's `state.totals = null` always
      // lands after the assignment below and the next call retries.
      await Promise.resolve()
      try {
        const client = await getSupabase()
        if (!client) return null
        const { data, error } = await client.from(flow.totalsTable).select('hour, total')
        if (error) throw error
        const totals = new Array<number>(24).fill(0)
        let any = false
        for (const { hour, total } of data as unknown as { hour: number; total: number }[]) {
          if (hour >= 0 && hour < 24 && total > 0) {
            totals[hour] = Number(total)
            any = true
          }
        }
        if (!any) throw new Error(`${flow.totalsTable} returned no rows (grant / RLS?)`)
        return totals
      } catch (err) {
        console.debug(`[urban-flow] Supabase (${flow.id}): hour totals unavailable —`, err)
        state.totals = null
        return null
      }
    })()
    state.totals = loading
  }
  return state.totals
}

/** Trips inside the half-open window — the sum of its hours. */
export function tripsInWindow(totals: readonly number[], range: HourRange): number {
  let sum = 0
  for (let h = range[0]; h < range[1]; h++) sum += totals[h] ?? 0
  return sum
}

/**
 * Particles for a window at "one particle = `tripsPerParticle` trips". At least
 * one while the window has any trips at all, so a quiet hour reads as quiet
 * rather than as a flow that failed to load.
 */
export function particlesForWindow(
  totals: readonly number[],
  range: HourRange,
  tripsPerParticle: number,
): number {
  const trips = tripsInWindow(totals, range)
  if (trips <= 0) return 0
  return Math.max(1, Math.round(trips / Math.max(1, tripsPerParticle)))
}

/**
 * One refresh tick for a (flow, window): sample a fresh batch and overwrite
 * random entries of the loaded reservoir IN PLACE — trip sources hold the array
 * itself, so it must never be swapped out. Skipped while the tab is hidden, while
 * the reservoir hasn't loaded (or loaded empty / failed), and thrown away if the
 * entry was replaced or evicted while the request was in flight — those legs
 * belong to a reservoir nobody holds. Never throws.
 */
function refreshReservoir(state: FlowState, flow: OdFlow, key: string, range: HourRange): void {
  if (document.hidden) return
  const cached = state.reservoirs.get(key)
  const places = state.places
  if (!cached || !places) return
  void (async () => {
    try {
      const client = await getSupabase()
      if (!client) return
      const legs = await cached
      if (!legs || legs.length === 0) return
      const fresh = await sampleLegs(client, flow, await places, range)
      if (state.reservoirs.get(key) !== cached) return
      for (const leg of fresh) legs[Math.floor(Math.random() * legs.length)] = leg
    } catch {
      // Keep playing the reservoir we have.
    }
  })()
}

/**
 * A source built for `range` is alive: pin the window in the LRU and, for the
 * first one, arm the window's refresh timer. Later sources on the same window
 * (other panels in lockstep) just count. Balanced by `releaseLease`.
 */
function acquireLease(state: FlowState, flow: OdFlow, range: HourRange): void {
  const key = rangeKey(range)
  const lease = state.leases.get(key)
  if (lease) {
    lease.refs += 1
    return
  }
  const timer = setInterval(() => refreshReservoir(state, flow, key, range), REFRESH_MS)
  state.leases.set(key, { refs: 1, timer })
}

/**
 * A source on `key` was disposed. The last one clears the timer; the reservoir
 * stays cached as an ordinary evictable LRU entry, so coming back is instant.
 */
function releaseLease(state: FlowState, key: string): void {
  const lease = state.leases.get(key)
  if (!lease) return
  lease.refs -= 1
  if (lease.refs > 0) return
  clearInterval(lease.timer)
  state.leases.delete(key)
}

/**
 * Trim the LRU: never the window just touched, never a leased one (a live source
 * holds its array). Map order = insertion order, so the first eligible key is
 * the least recently used.
 */
function evict(state: FlowState, keep: string): void {
  while (state.reservoirs.size > RESERVOIR_CACHE) {
    let oldest: string | undefined
    for (const key of state.reservoirs.keys()) {
      if (key !== keep && !state.leases.has(key)) {
        oldest = key
        break
      }
    }
    if (oldest === undefined) return
    state.reservoirs.delete(oldest)
  }
}

/**
 * The shared reservoir for one (flow, hour window), loaded at most once while it
 * stays in the LRU. Never rejects. `null` = Supabase can't supply this flow at
 * all (first failure, sticky for the page); `[]` = the flow connected but this
 * window failed to load — the key is forgotten so asking again retries, and the
 * source answers an empty batch, which parks its schedule. Refreshing is the
 * window's lease's business (`acquireLease`), not this loader's.
 */
function reservoirFor(flow: OdFlow, range: HourRange): Promise<Leg[] | null> {
  const state = stateFor(flow.id)
  const key = rangeKey(range)
  const cached = state.reservoirs.get(key)
  if (cached) {
    // LRU touch: re-inserting moves the key to the end of the iteration order.
    state.reservoirs.delete(key)
    state.reservoirs.set(key, cached)
    return cached
  }
  // Exactly one "[urban-flow] Supabase (<flow>): …" status line per flow and page
  // load, so the console answers "is this build talking to Supabase?" at a glance.
  // Later windows report themselves at debug level only.
  const tag = `[urban-flow] Supabase (${flow.id}):`
  let loading: Promise<Leg[] | null> | null = null
  loading = (async () => {
    // A flow that failed to connect stays failed for the page: one status line,
    // and no hammering a broken backend on every slider move.
    if (state.failed) return null
    try {
      const client = await getSupabase()
      if (!client) {
        state.failed = true
        if (!state.announced) {
          state.announced = true
          console.warn(
            `${tag} NOT CONFIGURED — VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing ` +
              'from this build',
          )
        }
        return null
      }
      const startedAt = performance.now()
      const places = await placesFor(state, client, flow)
      const batches = await Promise.all(
        Array.from({ length: RESERVOIR_BATCHES }, () => sampleLegs(client, flow, places, range)),
      )
      const legs = batches.flat()
      if (legs.length === 0) throw new Error(`${flow.sampleRpc} returned no usable pairs`)
      if (!state.announced) {
        state.announced = true
        console.info(
          `${tag} connected — ${places.size} places, ${legs.length} weighted OD samples in ` +
            `${Math.round(performance.now() - startedAt)} ms`,
        )
      } else {
        console.debug(`${tag} ${key}h — ${legs.length} weighted OD samples`)
      }
      return legs
    } catch (err) {
      if (!state.announced) {
        state.announced = true
        state.failed = true
        console.warn(`${tag} FAILED —`, err)
        return null
      }
      // Already connected once, so this is the window's problem, not the flow's:
      // forget it (asking again retries) and answer empty, which parks the
      // sources on this window rather than showing them some other window's trips.
      console.debug(`${tag} ${key}h unavailable —`, err)
      if (state.reservoirs.get(key) === loading) state.reservoirs.delete(key)
      return []
    }
  })()
  state.reservoirs.set(key, loading)
  evict(state, key)
  return loading
}

export interface OdTripOptions {
  /**
   * The time-of-day window this source samples in, fixed for its lifetime — a
   * panel that changes window builds a new source (and schedule). Clamped to
   * whole hours in [0, 24) / (from, 24], never wrapped. The source leases the
   * window's reservoir until `dispose()`.
   */
  range: HourRange
  /**
   * Supplies trips when Supabase is unconfigured or unreachable. Without one the
   * source returns nothing and the flow simply doesn't draw.
   */
  fallback?: TripSource
  seed?: number
  /** Poster-scale speed range in m/s, before `flow.speedScale`. Not physical. */
  speedMps?: [number, number]
}

/**
 * Trips sampled from a flow's real OD pairs in one time-of-day window. Never
 * rejects — TripQueue retries a rejecting source forever. When Supabase can't
 * supply the flow at all, batches come from `fallback` (or are empty); when just
 * this window fails to load after a successful connect, the batch is empty, which
 * parks the schedule — re-selecting the window builds a new source and retries.
 *
 * `dispose()` releases the reservoir lease; idempotent, and called once by the
 * schedule that plays this source when its last panel lets go.
 */
export function odTripSource(flow: OdFlow, opts: OdTripOptions): TripSource {
  const { fallback, seed = 0x5e0e1, speedMps = [500, 900] } = opts
  const rand = mulberry32(seed)
  const [minLng, minLat, maxLng, maxLat] = SEOUL_BOUNDS
  const state = stateFor(flow.id)
  const range = clampHourRange(opts.range[0], opts.range[1])
  acquireLease(state, flow, range)
  let disposed = false

  /** A point for this endpoint: the place itself, or uniform in its disc. */
  const locate = (place: Place): [number, number] => {
    const radius = place.radius * scatterScale
    if (radius <= 0) return place.center
    const r = radius * Math.sqrt(rand())
    const a = rand() * 2 * Math.PI
    const [lng, lat] = offsetMeters(place.center, r * Math.cos(a), r * Math.sin(a))
    return [Math.min(maxLng, Math.max(minLng, lng)), Math.min(maxLat, Math.max(minLat, lat))]
  }

  return {
    next: async (count) => {
      const legs = await reservoirFor(flow, range)
      if (legs === null) return fallback ? fallback.next(count) : []
      if (legs.length === 0) return []
      return Array.from({ length: count }, (): Trip => {
        let origin: [number, number]
        let destination: [number, number]
        let meters: number
        let tries = 0
        do {
          const leg = legs[Math.floor(rand() * legs.length)]
          origin = locate(leg.origin)
          destination = locate(leg.destination)
          meters = distanceMeters(origin, destination)
        } while (meters < flow.minDistanceMeters && ++tries < 20)
        const speed = (speedMps[0] + rand() * (speedMps[1] - speedMps[0])) * flow.speedScale
        return { origin, destination, durationSec: meters / speed }
      })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      releaseLease(state, rangeKey(range))
    },
  }
}
