import { WebMercatorViewport } from '@deck.gl/core'
import type { MapViewState } from '@deck.gl/core'
// SEOUL_BOUNDS lives in its own deck.gl-free module so the preprocessing
// scripts can import it; re-exported here to keep existing import paths.
export { SEOUL_BOUNDS } from './data/bounds'
import { SEOUL_BOUNDS } from './data/bounds'

// There is no basemap by design: deck.gl draws straight onto the plain --bg
// canvas so the visualization is one continuous dark surface with the site
// chrome. The geographic reference comes from the Seoul boundary, park and
// river overlays (src/layers/), not from map tiles — so no map library is a
// dependency of this project.

/**
 * Initial camera over Seoul: top-down plan view, north up (a user decision,
 * 2026-09-30 — the pitched "contour poster" look is one click away on the
 * panel's 2D/3D toggle, which tilts to PITCH_3D and keeps the bearing).
 */
export const INITIAL_VIEW_STATE: MapViewState = {
  longitude: 127.02,
  latitude: 37.55,
  zoom: 10.5,
  pitch: 0,
  bearing: 0,
}

/** App background — Carbon Gray 100 canvas (matches --bg in tokens.css). */
export const BG_COLOR = '#161616'

/**
 * Compute a view state that frames all of {@link SEOUL_BOUNDS} inside a panel of
 * the given pixel size, with the default (top-down, north-up) camera.
 *
 * `WebMercatorViewport.fitBounds` solves zoom+center for a *top-down* (pitch 0)
 * camera, so it fits the axis-aligned bounds exactly for `width×height`; the
 * padding (~7% of the smaller dimension, floored so tiny grid cells still get
 * breathing room) is the whole margin. When the user tilts to 3D the foreground
 * grows toward the bottom edge — accepted, since that is an interactive state
 * and the zoom buttons are right there.
 */
export function fitSeoulViewState(width: number, height: number): MapViewState {
  const [minLng, minLat, maxLng, maxLat] = SEOUL_BOUNDS
  const padding = Math.max(16, Math.min(width, height) * 0.07)
  const { longitude, latitude, zoom } = new WebMercatorViewport({
    width,
    height,
  }).fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding },
  )
  return { ...INITIAL_VIEW_STATE, longitude, latitude, zoom }
}
