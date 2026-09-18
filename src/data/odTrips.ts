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
 * The OD tables are far too big to download (bike ~930k pairs), so the weighted
 * draw happens in Postgres (one `sample_*` RPC per flow, see supabase/*.sql). To
 * keep egress flat the page holds ONE shared reservoir of weighted samples per
 * flow; every trip source draws uniformly from it (a uniform draw from a weighted
 * sample is still weighted). The reservoir is slowly refreshed so the long tail
 * of pairs rotates through.
 *
 * This file is the only place that knows the Supabase schema.
 */

export type FlowId = 'bike' | 'migration'

export interface OdFlow {
  id: FlowId
  /** UI copy for the dashboard toggle. */
  label: string
  /** Default particle color — the flows are told apart by color alone. */
  color: string
  /** Where the OD endpoints live: `placeId`, `lat`, `lon` columns. */
  placeTable: string
  placeId: string
  /** `(n int) → { o, d }[]` place-id pairs drawn ∝ trips, n ≤ 1000. */
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
    placeTable: 'bike_station',
    placeId: 'station_no',
    sampleRpc: 'sample_bike_od',
    scatter: false,
    speedScale: 0.6,
    minDistanceMeters: 300,
  },
  {
    id: 'migration',
    label: 'Living migration (생활이동)',
    color: '#f1c21b', // Carbon Yellow 30 — the one hue far from cyan, red and white
    placeTable: 'living_migration_adm_dong',
    placeId: 'admdong_cd',
    sampleRpc: 'sample_living_migration',
    scatter: true,
    speedScale: 0.6,
    minDistanceMeters: 300,
  },
]

export const FLOW_BY_ID = Object.fromEntries(FLOWS.map((f) => [f.id, f])) as Record<FlowId, OdFlow>

const PAGE_SIZE = 1000 // PostgREST max rows per request
const RESERVOIR_BATCHES = 5 // × PAGE_SIZE samples held in memory
const REFRESH_MS = 60_000

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

async function sampleLegs(client: SupabaseClient, flow: OdFlow, places: Places): Promise<Leg[]> {
  const { data, error } = await client.rpc(flow.sampleRpc, { n: PAGE_SIZE })
  if (error) throw error
  const legs: Leg[] = []
  for (const { o, d } of data as { o: number; d: number }[]) {
    const origin = places.get(o)
    const destination = places.get(d)
    if (origin && destination) legs.push({ origin, destination })
  }
  return legs
}

const reservoirs = new Map<FlowId, Promise<Leg[] | null>>()

/** A flow's shared reservoir, loaded once per page; `null` = Supabase can't supply it. */
function loadReservoir(flow: OdFlow): Promise<Leg[] | null> {
  let reservoir = reservoirs.get(flow.id)
  if (reservoir) return reservoir
  // Exactly one "[urban-flow] Supabase (<flow>): …" status line per flow and page
  // load, so the console answers "is this build talking to Supabase?" at a glance.
  const tag = `[urban-flow] Supabase (${flow.id}):`
  reservoir = (async () => {
    try {
      const client = await getSupabase()
      if (!client) {
        console.warn(
          `${tag} NOT CONFIGURED — VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing ` +
            'from this build',
        )
        return null
      }
      const startedAt = performance.now()
      const places = await loadPlaces(client, flow)
      // An RLS-blocked table answers 200 with zero rows, not an error.
      if (places.size === 0) throw new Error(`${flow.placeTable} returned no rows (RLS policy?)`)
      const batches = await Promise.all(
        Array.from({ length: RESERVOIR_BATCHES }, () => sampleLegs(client, flow, places)),
      )
      const legs = batches.flat()
      if (legs.length === 0) throw new Error(`${flow.sampleRpc} returned no usable pairs`)
      console.info(
        `${tag} connected — ${places.size} places, ${legs.length} weighted OD samples in ` +
          `${Math.round(performance.now() - startedAt)} ms`,
      )

      setInterval(() => {
        if (document.hidden) return
        sampleLegs(client, flow, places).then(
          (fresh) => {
            for (const leg of fresh) legs[Math.floor(Math.random() * legs.length)] = leg
          },
          () => {}, // keep playing the reservoir we have
        )
      }, REFRESH_MS)
      return legs
    } catch (err) {
      console.warn(`${tag} FAILED —`, err)
      return null
    }
  })()
  reservoirs.set(flow.id, reservoir)
  return reservoir
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
 * Trips sampled from a flow's real OD pairs. Never rejects — TripQueue retries a
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
      const legs = await loadReservoir(flow)
      if (!legs) return fallback ? fallback.next(count) : []
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
