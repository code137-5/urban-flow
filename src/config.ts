import type { MapViewState } from '@deck.gl/core'
import type { Bounds } from './data/types'

/**
 * CARTO dark-matter basemap style. Currently unused — we render on a plain dark
 * background, no basemap. Kept in case a faint geographic reference is wanted later
 * (re-add react-map-gl/maplibre <Map> in the dashboard view).
 */
export const BASEMAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

/** Seoul area of interest: [minLng, minLat, maxLng, maxLat]. */
export const SEOUL_BOUNDS: Bounds = [126.76, 37.42, 127.18, 37.7]

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
