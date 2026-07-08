import { useEffect, useMemo, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { Layer } from '@deck.gl/core'
import { INITIAL_VIEW_STATE, SEOUL_BOUNDS } from '../config'
import { computeHeightmap } from '../data/field'
import ContourTerrainLayer from '../layers/ContourTerrainLayer'
import { seoulBoundaryLayer } from '../layers/seoulBoundaryLayer'
import { parkLayer, riverLayer } from '../layers/featureOverlays'
import type { DataSource, GeoPoint, Heightmap } from '../data/types'
import styles from './Dashboard.module.css'

// KDE bandwidth (meters). Tuned in the reference project: at 1800m ~92% of
// in-Seoul cells clear the contour floor, so the field reads as continuous
// terrain instead of isolated peaks over flat ground.
const SIGMA_METERS = 1800
// 200×200 matches the reference; the Seoul mask (point-in-polygon) for it is
// ~1s once per session, then cached.
const GRID_SIZE = 200
// Contour bands. interval = 1 / count.
const CONTOUR_COUNT = 16
const HEIGHT_SCALE = 4000

// The shared INITIAL_VIEW_STATE frames Seoul for a full-screen canvas; inside a
// bounded panel it reads low, so tighten zoom and drop the center a touch to fill.
const PANEL_VIEW_STATE = {
  ...INITIAL_VIEW_STATE,
  latitude: 37.535,
  zoom: 10.9,
}

/** Hex '#rrggbb' → [r, g, b] 0–255. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * A single dashboard panel: real deck.gl contour terrain for one `DataSource`.
 * The KDE heightmap + Seoul mask are computed once (deferred a frame so the
 * loading state paints first), then rendered as a static "contour poster" at
 * the pitched Seoul view. Contour color ramps hairline-gray → the source accent.
 */
export function TerrainPanel({ source }: { source: DataSource }) {
  const [points, setPoints] = useState<GeoPoint[] | null>(null)
  const [heightmap, setHeightmap] = useState<Heightmap | null>(null)

  useEffect(() => {
    let alive = true
    source.load().then((p) => {
      if (alive) setPoints(p)
    })
    return () => {
      alive = false
    }
  }, [source])

  // Defer the heavy KDE + mask one frame so the loading label paints before the
  // main thread blocks on the (one-time, then cached) computation.
  useEffect(() => {
    if (!points) return
    let alive = true
    const id = setTimeout(() => {
      const hm = computeHeightmap(points, SEOUL_BOUNDS, {
        gridSize: GRID_SIZE,
        sigmaMeters: SIGMA_METERS,
      })
      if (alive) setHeightmap(hm)
    }, 0)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [points])

  const layers = useMemo<Layer[]>(() => {
    if (!heightmap) return []
    return [
      // Flat z=0 reference plate under the terrain: Seoul outline, then parks
      // and river (muted so they don't compete with the contours).
      seoulBoundaryLayer({ lineColor: [82, 82, 82, 170], fillColor: [80, 80, 80, 18] }),
      parkLayer(),
      riverLayer(),
      new ContourTerrainLayer({
        id: `terrain-${source.meta.id}`,
        heightmap,
        interval: 1 / CONTOUR_COUNT,
        heightScale: HEIGHT_SCALE,
        lineColor: [57, 57, 57], // --border-subtle: low elevation
        peakColor: hexToRgb(source.meta.accent), // IBM Blue 40: high elevation
      }),
    ]
  }, [heightmap, source])

  return (
    <>
      <DeckGL
        style={{ position: 'absolute', inset: '0' }}
        viewState={PANEL_VIEW_STATE}
        controller={false}
        layers={layers}
      />
      {!heightmap && (
        <div className={styles.loading} role="status">
          Building terrain…
        </div>
      )}
    </>
  )
}
