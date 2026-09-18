import type { SupabaseClient } from '@supabase/supabase-js'
import { SEOUL_BOUNDS } from './bounds'
import { getSupabase } from './supabase'
import { distanceMeters, mulberry32 } from './trips'
import type { Trip, TripSource } from './trips'

/**
 * Real particle trips: Ttareungi (따릉이, Seoul public bike) origin→destination
 * pairs from Supabase, drawn with probability ∝ their trip count.
 *
 * The OD table has ~930k pairs, far too many to download, so the weighted draw
 * happens in Postgres (`sample_bike_od`, see supabase/bike_od_sampling.sql). To
 * keep egress flat the page holds ONE shared reservoir of weighted samples; every
 * `bikeTripSource` draws uniformly from it (a uniform draw from a weighted sample
 * is still weighted). The reservoir is slowly refreshed so the long tail of pairs
 * rotates through.
 *
 * This file is the only place that knows the Supabase schema.
 */

const STATION_TABLE = 'bike_station' // station_no, lat, lon (+ name, district, totals)
const SAMPLE_RPC = 'sample_bike_od' // (n int) → { o, d }[] station_no pairs, n ≤ 1000
const PAGE_SIZE = 1000 // PostgREST max rows per request
const RESERVOIR_BATCHES = 5 // × PAGE_SIZE samples held in memory
const REFRESH_MS = 60_000

/** One sampled OD pair resolved to coordinates; duration is set per draw. */
interface Leg {
  origin: [number, number]
  destination: [number, number]
  meters: number
}

type Stations = Map<number, [number, number]>

async function loadStations(client: SupabaseClient): Promise<Stations> {
  const [minLng, minLat, maxLng, maxLat] = SEOUL_BOUNDS
  const stations: Stations = new Map()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(STATION_TABLE)
      .select('station_no, lat, lon')
      .order('station_no')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data as { station_no: number; lat: number; lon: number }[]
    for (const { station_no, lat, lon } of rows) {
      // Trip endpoints are never clamped downstream (lngLatToUv), so a station
      // outside the bounds would draw its particle off the terrain.
      if (lon >= minLng && lon <= maxLng && lat >= minLat && lat <= maxLat) {
        stations.set(station_no, [lon, lat])
      }
    }
    if (rows.length < PAGE_SIZE) return stations
  }
}

async function sampleLegs(client: SupabaseClient, stations: Stations): Promise<Leg[]> {
  const { data, error } = await client.rpc(SAMPLE_RPC, { n: PAGE_SIZE })
  if (error) throw error
  const legs: Leg[] = []
  for (const { o, d } of data as { o: number; d: number }[]) {
    const origin = stations.get(o)
    const destination = stations.get(d)
    if (origin && destination) {
      legs.push({ origin, destination, meters: distanceMeters(origin, destination) })
    }
  }
  return legs
}

let reservoir: Promise<Leg[] | null> | null = null

/** The shared reservoir, loaded once per page; `null` = use the fallback source. */
function loadReservoir(): Promise<Leg[] | null> {
  reservoir ??= (async () => {
    try {
      // Exactly one "[urban-flow] Supabase: …" status line per page load, so the
      // console answers "is this build talking to Supabase?" at a glance.
      const client = await getSupabase()
      if (!client) {
        console.warn(
          '[urban-flow] Supabase: NOT CONFIGURED — VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY ' +
            'are missing from this build; particles play random trips',
        )
        return null
      }
      const startedAt = performance.now()
      const stations = await loadStations(client)
      // An RLS-blocked table answers 200 with zero rows, not an error.
      if (stations.size === 0) throw new Error(`${STATION_TABLE} returned no rows (RLS policy?)`)
      const batches = await Promise.all(
        Array.from({ length: RESERVOIR_BATCHES }, () => sampleLegs(client, stations)),
      )
      const legs = batches.flat()
      if (legs.length === 0) throw new Error(`${SAMPLE_RPC} returned no usable pairs`)
      console.info(
        `[urban-flow] Supabase: connected — ${stations.size} stations, ${legs.length} weighted ` +
          `OD samples in ${Math.round(performance.now() - startedAt)} ms; particles play real ` +
          'Ttareungi trips',
      )

      setInterval(() => {
        if (document.hidden) return
        sampleLegs(client, stations).then(
          (fresh) => {
            for (const leg of fresh) legs[Math.floor(Math.random() * legs.length)] = leg
          },
          () => {}, // keep playing the reservoir we have
        )
      }, REFRESH_MS)
      return legs
    } catch (err) {
      console.warn('[urban-flow] Supabase: FAILED — particles play random trips:', err)
      return null
    }
  })()
  return reservoir
}

export interface BikeTripOptions {
  /** Supplies trips when Supabase is unconfigured or unreachable. */
  fallback: TripSource
  seed?: number
  /** Poster-scale speed range in m/s; duration = distance / speed. Not physical. */
  speedMps?: [number, number]
  /** Skip pairs closer than this — a particle that short just blinks in place. */
  minDistanceMeters?: number
}

/**
 * Trips sampled from real Ttareungi OD pairs. Never rejects and never runs dry —
 * TripQueue retries a rejecting source forever and latches `exhausted` on an
 * empty batch — so any failure is handed to `fallback` instead.
 */
export function bikeTripSource(opts: BikeTripOptions): TripSource {
  const { fallback, seed = 0x5e0e1, speedMps = [500, 900], minDistanceMeters = 300 } = opts
  const rand = mulberry32(seed)

  return {
    next: async (count) => {
      const legs = await loadReservoir()
      if (!legs) return fallback.next(count)
      return Array.from({ length: count }, (): Trip => {
        let leg = legs[Math.floor(rand() * legs.length)]
        let tries = 0
        while (leg.meters < minDistanceMeters && ++tries < 20) {
          leg = legs[Math.floor(rand() * legs.length)]
        }
        const speed = speedMps[0] + rand() * (speedMps[1] - speedMps[0])
        return { origin: leg.origin, destination: leg.destination, durationSec: leg.meters / speed }
      })
    },
  }
}
