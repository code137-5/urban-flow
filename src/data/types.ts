/**
 * Core, source-agnostic data model.
 *
 * The whole visualization pipeline (heightmap → contour → particles) depends only
 * on `GeoPoint` — never on dataset-specific fields. New datasets plug in by
 * implementing `DataSource` in src/data/sources/.
 */

/** Geographic bounds: [minLng, minLat, maxLng, maxLat]. */
export type Bounds = [number, number, number, number]

/** Per-hour weights, length 24 (index = hour 0..23). Used for time-of-day animation. */
export type HourlyWeights = readonly number[]

/** A weighted geographic point — the atom of every dataset. */
export interface GeoPoint {
  lng: number
  lat: number
  /** Aggregate intensity at this point (drives heightmap + particle density). */
  weight: number
  /** Optional per-hour breakdown (length 24) for the time-of-day scrubber. */
  weightByHour?: HourlyWeights
}

/** Identifiers for the datasets compared in the dashboard. */
export type DatasetId = 'ttareungi' | 'saenghwal-idong' | 'subway'

export interface DatasetMeta {
  id: DatasetId
  /** Display name. */
  label: string
  /** One-line description shown in the dashboard panel header. */
  description: string
  /** Unit of the weight, e.g. 'rentals', 'people moved', 'riders'. */
  unit: string
  /** Accent hue (particles/contours) so panels are visually distinguishable. */
  accent: string
}

/** Pluggable data adapter. One implementation per dataset in src/data/sources/. */
export interface DataSource {
  meta: DatasetMeta
  /** Load & normalize the dataset into weighted geopoints. */
  load(): Promise<GeoPoint[]>
}
