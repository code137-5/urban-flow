import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
// Real Seoul boundary: southkorea/seoul-maps, 25 자치구 polygons (통계청 2013).
// Bundled at build time as a raw string (Vite ?raw), like the Ttareungi CSV.
// Shared by the mask (data/mask.ts) and the boundary outline layer
// (layers/seoulBoundaryLayer.ts) so the file is parsed once.
import seoulGeoRaw from '../../data/seoul_municipalities_geo_simple.json?raw'

export type SeoulProps = {
  code: string
  name: string
  name_eng: string
  base_year: string
}

/** All 25 자치구 as a GeoJSON FeatureCollection (Polygon geometries). */
export const SEOUL_BOUNDARY = JSON.parse(seoulGeoRaw) as FeatureCollection<
  Polygon | MultiPolygon,
  SeoulProps
>

export const SEOUL_FEATURES: Feature<Polygon | MultiPolygon, SeoulProps>[] =
  SEOUL_BOUNDARY.features
