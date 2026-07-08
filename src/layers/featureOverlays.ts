import { GeoJsonLayer } from '@deck.gl/layers'

// River + park reference overlays, drawn flat at ground level (z=0) beneath the
// contour terrain — same backdrop-plate role as the Seoul boundary. The GeoJSON
// (reprojected EPSG:5174→WGS84 and simplified, from Aete/seoul-terrain-animation)
// is fetched at runtime from public/geo/. `depthTest: false` keeps them a clean
// plate under the terrain relief.
//
// Colors are deliberately low-saturation (muted slate / sage) so they read as a
// quiet geographic reference and don't compete with the IBM Blue contours.

const RIVER_URL = `${import.meta.env.BASE_URL}geo/seoul_river.geojson`
const PARK_URL = `${import.meta.env.BASE_URL}geo/seoul_park.geojson`

export type FeatureOverlayOptions = {
  /** Fill color, RGBA 0–255. */
  fillColor?: [number, number, number, number]
}

/** Han river + other water bodies, muted slate-blue fill on the ground plane. */
export function riverLayer({
  fillColor = [72, 90, 108, 82],
}: FeatureOverlayOptions = {}): GeoJsonLayer {
  return new GeoJsonLayer({
    id: 'seoul-river',
    data: RIVER_URL,
    stroked: false,
    filled: true,
    getFillColor: fillColor,
    updateTriggers: { getFillColor: fillColor },
    parameters: { depthTest: false },
  })
}

/** City parks, muted sage-green fill on the ground plane. */
export function parkLayer({
  fillColor = [78, 94, 82, 66],
}: FeatureOverlayOptions = {}): GeoJsonLayer {
  return new GeoJsonLayer({
    id: 'seoul-park',
    data: PARK_URL,
    stroked: false,
    filled: true,
    getFillColor: fillColor,
    updateTriggers: { getFillColor: fillColor },
    parameters: { depthTest: false },
  })
}
