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
 * reservoir of weighted samples per (flow, hour window); every trip source draws
 * uniformly from the current one (a uniform draw from a weighted sample is still
 * weighted). A small LRU of windows means going back to a window already looked at
 * costs nothing, and one timer per flow slowly refreshes the visible window so the
 * long tail of pairs rotates through.
 *
 * The time-of-day window is page-wide module state here, NOT a parameter of the
 * schedule key (tripSchedule.ts): keying schedules by it would tear down every
 * ParticleLayer and blank the swarm on each change. Instead the window is read at
 * `next()` time and the schedules' prefetch pools are flushed, so particles in
 * flight land normally and only the trips after them come from the new window.
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
  /** Where the OD endpoints live: `placeId`, `lat`, `lon` columns. */
  placeTable: string
  placeId: string
  /**
   * `(n int, hour_from int, hour_to int) → { o, d }[]` place-id pairs drawn
   * ∝ trips within the half-open hour window, n ≤ 1000.
   */
  sampleRpc: string
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
    placeTable: 'bike_station',
    placeId: 'station_no',
    sampleRpc: 'sample_bike_od_hourly',
    scatter: false,
    speedScale: 0.6,
    minDistanceMeters: 300,
  },
  {
    id: 'migration',
    label: 'Living migration (생활이동)',
    color: '#f1c21b', // Carbon Yellow 30 — the one hue far from cyan, red and white
    defaultOn: true,
    placeTable: 'living_migration_adm_dong',
    placeId: 'admdong_cd',
    sampleRpc: 'sample_living_migration_hourly',
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

/**
 * The dashboard-wide time-of-day window. Page-wide module state on purpose: it
 * must stay out of the shared-schedule key (see the file header), and every panel
 * and both flows read the same one.
 */
let hourRange: HourRange = DEFAULT_HOUR_RANGE

/** Whole hours, `lo` in [0,23] and `hi` in [lo+1,24] — clamped, never wrapped. */
function clampHourRange(from: number, to: number): HourRange {
  const lo = Math.min(23, Math.max(0, Math.round(from)))
  return [lo, Math.min(24, Math.max(lo + 1, Math.round(to)))]
}

/**
 * Move the window. Returns true only when it actually moved, so the caller knows
 * whether to flush the schedules — and so a repeated (or StrictMode-doubled) call
 * with the same hours is a no-op.
 */
export function setOdHourRange(from: number, to: number): boolean {
  const next = clampHourRange(from, to)
  if (next[0] === hourRange[0] && next[1] === hourRange[1]) return false
  hourRange = next
  return true
}

export function getOdHourRange(): HourRange {
  return hourRange
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

async function loadPlaces(client: SupabaseClient, flow: OdFlow): Promise<Places> {
  const [minLng, minLat, maxLng, maxLat] = SEOUL_BOUNDS
  const places: Places = new Map()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(flow.placeTable)
      .select(`id:${flow.placeId}, lat, lon`)
      .order(flow.placeId)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data as unknown as { id: number; lat: number; lon: number }[]
    for (const { id, lat, lon } of rows) {
      // Trip endpoints are never clamped downstream (lngLatToUv), so a place
      // outside the bounds would draw its particle off the terrain.
      if (lon >= minLng && lon <= maxLng && lat >= minLat && lat <= maxLat) {
        places.set(id, { center: [lon, lat], radius: 0 })
      }
    }
    if (rows.length < PAGE_SIZE) break
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

/** Everything the page keeps per flow. One instance, created on first use. */
interface FlowState {
  /** Endpoint coordinates — hour-independent, so paginated once and reused. */
  places: Promise<Places> | null
  /** Reservoir per hour window, keyed `${from}-${to}`, used as an LRU. */
  reservoirs: Map<string, Promise<Leg[] | null>>
  /** The most recent reservoir that actually loaded — what a failed window falls back to. */
  live: Leg[] | null
  /** The one slow-refresh interval, armed by the first reservoir that loaded. */
  timer: ReturnType<typeof setInterval> | null
  /** Whether this flow has already printed its one console status line. */
  announced: boolean
  /** Sticky: Supabase can't supply this flow at all this page load. */
  failed: boolean
}

const states = new Map<FlowId, FlowState>()

function stateFor(flow: OdFlow): FlowState {
  let state = states.get(flow.id)
  if (!state) {
    state = {
      places: null,
      reservoirs: new Map(),
      live: null,
      timer: null,
      announced: false,
      failed: false,
    }
    states.set(flow.id, state)
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
      if (places.size === 0) throw new Error(`${flow.placeTable} returned no rows (RLS policy?)`)
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
 * One slow refresh timer per flow: every tick it samples fresh legs for whichever
 * window is on screen *now* and overwrites random entries of that reservoir IN
 * PLACE — trip sources hold the array itself, so it must never be swapped out.
 */
function armRefresh(state: FlowState, client: SupabaseClient, flow: OdFlow): void {
  if (state.timer !== null) return
  state.timer = setInterval(() => {
    if (document.hidden) return
    const range = hourRange
    const key = rangeKey(range)
    const cached = state.reservoirs.get(key)
    const places = state.places
    if (!cached || !places) return
    void (async () => {
      try {
        const legs = await cached
        if (!legs || legs.length === 0) return
        const fresh = await sampleLegs(client, flow, await places, range)
        // The window may have moved on (or this entry been evicted) while the
        // request was in flight — those legs belong to a reservoir nobody holds.
        if (state.reservoirs.get(key) !== cached) return
        for (const leg of fresh) legs[Math.floor(Math.random() * legs.length)] = leg
      } catch {
        // Keep playing the reservoir we have.
      }
    })()
  }, REFRESH_MS)
}

/** Trim the LRU, never the window just touched (Map order = insertion order). */
function evict(state: FlowState, keep: string): void {
  while (state.reservoirs.size > RESERVOIR_CACHE) {
    let oldest: string | undefined
    for (const key of state.reservoirs.keys()) {
      if (key !== keep) {
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
 * stays in the LRU; `null` = Supabase can't supply it. Never rejects, and never
 * resolves empty after a successful connect: a window that fails to load keeps the
 * previous one playing instead of stalling the swarm.
 */
function reservoirFor(flow: OdFlow, range: HourRange): Promise<Leg[] | null> {
  const state = stateFor(flow)
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
      state.live = legs
      if (!state.announced) {
        state.announced = true
        console.info(
          `${tag} connected — ${places.size} places, ${legs.length} weighted OD samples in ` +
            `${Math.round(performance.now() - startedAt)} ms`,
        )
      } else {
        console.debug(`${tag} ${key}h — ${legs.length} weighted OD samples`)
      }
      armRefresh(state, client, flow)
      return legs
    } catch (err) {
      if (!state.announced) {
        state.announced = true
        state.failed = true
        console.warn(`${tag} FAILED —`, err)
        return null
      }
      // Already connected once, so this is the window's problem, not the flow's:
      // forget it (re-selecting retries) and keep the last loaded one playing.
      console.debug(`${tag} ${key}h unavailable, keeping the previous window —`, err)
      if (state.reservoirs.get(key) === loading) state.reservoirs.delete(key)
      return state.live
    }
  })()
  state.reservoirs.set(key, loading)
  evict(state, key)
  return loading
}

export interface OdTripOptions {
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
 * Trips sampled from a flow's real OD pairs, in whatever time-of-day window is
 * selected when the batch is requested. Never rejects — TripQueue retries a
 * rejecting source forever — so any failure is handed to `fallback`, or answered
 * with an empty batch (which parks the flow for this page load).
 */
export function odTripSource(flow: OdFlow, opts: OdTripOptions = {}): TripSource {
  const { fallback, seed = 0x5e0e1, speedMps = [500, 900] } = opts
  const rand = mulberry32(seed)
  const [minLng, minLat, maxLng, maxLat] = SEOUL_BOUNDS

  /** A point for this endpoint: the place itself, or uniform in its disc. */
  const locate = (place: Place): [number, number] => {
    if (place.radius <= 0) return place.center
    const r = place.radius * Math.sqrt(rand())
    const a = rand() * 2 * Math.PI
    const [lng, lat] = offsetMeters(place.center, r * Math.cos(a), r * Math.sin(a))
    return [Math.min(maxLng, Math.max(minLng, lng)), Math.min(maxLat, Math.max(minLat, lat))]
  }

  return {
    next: async (count) => {
      // Read the window at call time, not at construction: the source outlives
      // every change to it, and the pool it feeds was flushed for exactly this.
      const legs = await reservoirFor(flow, hourRange)
      if (!legs || legs.length === 0) return fallback ? fallback.next(count) : []
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
  }
}
