import { WebMercatorViewport } from '@deck.gl/core'
import type { MapViewState } from '@deck.gl/core'
// SEOUL_BOUNDS lives in its own deck.gl-free module so the preprocessing
// scripts can import it; re-exported here to keep existing import paths.
export { SEOUL_BOUNDS } from './data/bounds'
import { SEOUL_BOUNDS } from './data/bounds'

/**
 * CARTO dark-matter basemap style. Currently unused — we render on a plain dark
 * background, no basemap. Kept in case a faint geographic reference is wanted later
 * (re-add react-map-gl/maplibre <Map> in the dashboard view).
 */
export const BASEMAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

/** Initial camera over Seoul: high pitch for the "contour poster" look. */
export const INITIAL_VIEW_STATE: MapViewState = {
  longitude: 127.02,
  latitude: 37.55,
  zoom: 10.5,
  pitch: 60,
  bearing: -20,
}

/** App background — Carbon Gray 100 canvas (matches --bg in tokens.css). */
export const BG_COLOR = '#161616'

/**
 * Compute a view state that frames all of {@link SEOUL_BOUNDS} inside a panel of
 * the given pixel size, then re-applies the "contour poster" pitch/bearing.
 *
 * `WebMercatorViewport.fitBounds` solves zoom+center for a *top-down* (pitch 0)
 * camera, so it fits the axis-aligned bounds exactly for `width×height`. We then
 * tilt to pitch 60 and rotate to bearing −20, which changes what the frame sees:
 *  - the tilt magnifies the foreground, pushing the near (south) edge downward;
 *  - the −20° rotation means the rotated bounding box is wider/taller than the
 *    axis-aligned one fitBounds solved for.
 * Both effects eat into the margin, so we (a) pad generously — ~10% of the
 * smaller dimension, floored so tiny grid cells still get breathing room — and
 * (b) back the zoom off a touch. A small upward center nudge keeps the tilted
 * city sitting comfortably rather than riding the bottom edge. Tuned by
 * screenshot across 4:3, portrait, and narrow aspect ratios.
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
  return {
    ...INITIAL_VIEW_STATE,
    longitude,
    // Nudge the center slightly north so the pitched frame doesn't push
    // southern Seoul off the bottom edge.
    latitude: latitude + 0.008,
    // Back off the top-down fit zoom to leave margin once tilted + rotated.
    zoom: zoom - 0.3,
  }
}
