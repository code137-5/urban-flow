import type { DataSource, DatasetMeta, GeoPoint } from '../types'

/**
 * A DataSource backed by a preprocessed static file at public/data/<id>.json,
 * produced by scripts/preprocess. Fetched at runtime (same BASE_URL pattern as
 * the river/park overlays in src/layers/featureOverlays.ts) so it stays out of
 * the JS bundle. Any new preprocessed dataset is a one-line `staticSource({...})`.
 */
export function staticSource(meta: DatasetMeta): DataSource {
  return {
    meta,
    load: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}data/${meta.id}.json`)
      if (!res.ok) {
        throw new Error(`Failed to load ${meta.id}: ${res.status} ${res.statusText}`)
      }
      return (await res.json()) as GeoPoint[]
    },
  }
}
