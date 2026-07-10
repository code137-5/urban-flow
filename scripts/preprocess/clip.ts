import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { GeoPoint } from '../../src/data/types.ts'

// The 25 자치구 polygons, read straight off disk. We can't reuse src/data/mask.ts
// or seoulGeo.ts here — those import the JSON via Vite's `?raw`, which only exists
// in the browser/Vite build, not in a plain Node (tsx) context. So we mirror the
// point-in-polygon logic and load the same file with fs.
const GEO_PATH = fileURLToPath(
  new URL('../../data/seoul_municipalities_geo_simple.json', import.meta.url),
)

let features: Feature<Polygon | MultiPolygon>[] | null = null
function seoulFeatures(): Feature<Polygon | MultiPolygon>[] {
  if (!features) {
    const fc = JSON.parse(readFileSync(GEO_PATH, 'utf8')) as FeatureCollection<
      Polygon | MultiPolygon
    >
    features = fc.features
  }
  return features
}

/** Inside Seoul iff the point falls in any of the 25 자치구 polygons. */
function inSeoul(lng: number, lat: number): boolean {
  for (const f of seoulFeatures()) {
    if (booleanPointInPolygon([lng, lat], f)) return true
  }
  return false
}

/**
 * Drop points that fall outside the Seoul boundary. The frontend re-applies the
 * same mask at render time, but clipping here shrinks the shipped JSON — cells
 * over the surrounding province are never drawn anyway.
 */
export function clipToSeoul(points: GeoPoint[]): GeoPoint[] {
  return points.filter((p) => inSeoul(p.lng, p.lat))
}
