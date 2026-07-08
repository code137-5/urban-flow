import type { DataSource, GeoPoint } from '../types'
// Bundled at build time as a raw string (Vite ?raw). This is synthetic mock
// data (120 stations clustered around Gangnam/Hongdae/Yeouido/Jamsil), ported
// from Aete/seoul-terrain-animation for the visual preview — not real Ttareungi
// figures. A real adapter would fetch the open dataset and map it the same way.
import csv from '../../../data/sample_stations.csv?raw'

/**
 * Parse the mock CSV (lng,lat,tripCount,h0..h23) into source-agnostic GeoPoints.
 * Ttareungi-specific field mapping lives here and nowhere else:
 *   tripCount → weight, [h0..h23] → weightByHour.
 */
function parse(text: string): GeoPoint[] {
  const lines = text.trim().split(/\r?\n/)
  return lines.slice(1).map((line) => {
    const c = line.split(',').map(Number)
    return {
      lng: c[0],
      lat: c[1],
      weight: c[2],
      weightByHour: c.slice(3, 27),
    }
  })
}

export const ttareungiSource: DataSource = {
  meta: {
    id: 'ttareungi',
    label: 'Ttareungi (public bike)',
    description: 'Seoul density as contour terrain',
    unit: 'rentals',
    accent: '#78a9ff', // IBM Blue 40 — high-elevation contour color
  },
  load: async () => parse(csv),
}
