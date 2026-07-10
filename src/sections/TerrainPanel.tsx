import { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { LinearInterpolator } from '@deck.gl/core'
import type { Layer, MapViewState, ViewStateChangeParameters } from '@deck.gl/core'
import { INITIAL_VIEW_STATE, SEOUL_BOUNDS, fitSeoulViewState } from '../config'
import { computeHeightmap } from '../data/field'
import ContourTerrainLayer from '../layers/ContourTerrainLayer'
import { seoulBoundaryLayer } from '../layers/seoulBoundaryLayer'
import { parkLayer, riverLayer } from '../layers/featureOverlays'
import { ContourFallback } from './ContourFallback'
import { terrainShaderSupported } from '../layers/terrainSupport'
import { shaderErrors, type ShaderError } from '../webgl-compat'
import type { DataSource, GeoPoint, Heightmap } from '../data/types'
import styles from './Dashboard.module.css'

// 200×200 matches the reference; the Seoul mask (point-in-polygon) for it is
// ~1s once per session, then cached.
const GRID_SIZE = 200

// Fallback view used before the container has been measured (0×0 during the
// first render, before layout). The shared INITIAL_VIEW_STATE frames Seoul for a
// full-screen canvas; inside a bounded panel it reads low, so tighten zoom and
// drop the center a touch. Once measured, `fitSeoulViewState` replaces this with
// a size-fitted camera.
const PANEL_VIEW_STATE = {
  ...INITIAL_VIEW_STATE,
  latitude: 37.535,
  zoom: 10.9,
}

// Interaction bounds. The camera is a constrained turntable: users may zoom and
// rotate (bearing) only — panning and free-tilt are disabled so Seoul stays
// framed and centered. Tilt is switched between two fixed presets by the 2D/3D
// toggle rather than dragged.
const MIN_ZOOM = 9
const MAX_ZOOM = 14
const ZOOM_STEP = 0.6
const PITCH_3D = 60 // the tilted "contour poster" look
const PITCH_2D = 0 // top-down plan view

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Eased transitions: +/- buttons animate zoom; the 2D/3D toggle animates tilt.
const zoomInterpolator = new LinearInterpolator(['zoom'])
const pitchInterpolator = new LinearInterpolator(['pitch'])

/**
 * The user-controllable camera params for a panel: zoom, bearing (rotation), and
 * pitch (2D↔3D). Center is intentionally excluded — each panel keeps its own
 * size-fitted center so panning is impossible and Seoul stays framed. Shared
 * verbatim across panels when the dashboard's "sync views" option is on.
 * Optional transition props ride along so a button/toggle change animates.
 */
export type PanelCamera = {
  zoom: number
  bearing: number
  pitch: number
  transitionDuration?: number
  transitionInterpolator?: LinearInterpolator
}

/**
 * Live-tunable render settings. Defaults: a gray contour ramp (dark hairline →
 * light gray) with a saturated slate-blue river as the one colored element.
 * Every value is adjustable in-browser via the lil-gui tuner — open it with the
 * `?tune` URL param (hidden by default so the site stays clean).
 */
type Controls = {
  count: number
  height: number
  sigma: number
  lineColor: string
  peakColor: string
  contourOpacity: number
  boundaryColor: string
  boundaryOpacity: number
  parkColor: string
  parkOpacity: number
  riverColor: string
  riverOpacity: number
}

const DEFAULT_CONTROLS: Controls = {
  count: 16,
  height: 4000,
  // KDE bandwidth (m). ~1800m makes the field read as continuous terrain
  // rather than isolated peaks over flat ground (tuned in the reference).
  sigma: 1800,
  lineColor: '#393939', // low elevation — dark hairline gray
  peakColor: '#c6c6c6', // high elevation — light gray
  contourOpacity: 1,
  boundaryColor: '#525252',
  boundaryOpacity: 0.67,
  parkColor: '#4e5e52', // muted sage
  parkOpacity: 0.26,
  riverColor: '#4a80b0', // saturated slate-blue — the one accent color
  riverOpacity: 0.42,
}

/** Hex '#rrggbb' → [r, g, b] 0–255. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Hex '#rrggbb' + opacity 0–1 → [r, g, b, a] 0–255. */
function hexToRgba(hex: string, opacity: number): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex)
  return [r, g, b, Math.round(opacity * 255)]
}

/** Show the color tuner only when the page is opened with `?tune`. */
function tuningEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('tune')
}

/**
 * A single dashboard panel: real deck.gl contour terrain for one `DataSource`.
 * The KDE heightmap + Seoul mask are computed once (deferred a frame so the
 * loading state paints first), then rendered at the pitched Seoul view. Colors
 * come from `Controls` and are live-tunable via lil-gui.
 *
 * The camera is controlled: `camera` (zoom/bearing/pitch, center excluded) is
 * merged onto the size-fitted view, and every change is reported via
 * `onCameraChange`. The dashboard owns this state so it can mirror one panel's
 * camera across all panels ("sync views"). A null `camera` means "use the fit".
 */
export function TerrainPanel({
  source,
  camera,
  onCameraChange,
}: {
  source: DataSource
  camera: PanelCamera | null
  onCameraChange: (camera: PanelCamera) => void
}) {
  const [points, setPoints] = useState<GeoPoint[] | null>(null)
  const [heightmap, setHeightmap] = useState<Heightmap | null>(null)
  // Set when source.load() rejects (e.g. a preprocessed static file is missing).
  const [loadError, setLoadError] = useState<string | null>(null)
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS)
  // If deck.gl can't initialize/compile on this device (some mobile GPUs), fall
  // back to a zero-WebGL SVG contour so the panel is never blank.
  const [webglFailed, setWebglFailed] = useState(false)
  // Captured shader compile error (for on-screen diagnostics on mobile).
  const [shaderError, setShaderError] = useState<ShaderError | null>(null)
  // The DeckGL container's measured pixel size. Drives the fitted camera so the
  // whole Seoul area stays framed at any panel width/height. `null` until the
  // first ResizeObserver callback (guards against 0×0 before layout).
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  // Measure our OWN container (not the window) so a panel in a responsive grid
  // reframes when its cell grows/shrinks. Recomputes on mount + every resize.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (!r || r.width === 0 || r.height === 0) return
      setSize({ width: r.width, height: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fitted "contour poster" camera for the current panel size. Falls back to the
  // sensible default until the container has been measured. This is the *base*
  // view: it reframes on resize and supplies defaults before the user interacts.
  const fittedView = useMemo<MapViewState>(
    () => (size ? fitSeoulViewState(size.width, size.height) : PANEL_VIEW_STATE),
    [size],
  )

  // Effective controllable params: the (possibly shared) camera if set, else the
  // fit. Center always comes from `fittedView` and is never overridden, so the
  // panel can't be panned off Seoul.
  const effectiveZoom = camera?.zoom ?? fittedView.zoom
  const effectiveBearing = camera?.bearing ?? fittedView.bearing ?? 0
  const effectivePitch = camera?.pitch ?? fittedView.pitch ?? PITCH_3D
  const is3d = effectivePitch > 0

  const viewState: MapViewState = {
    ...fittedView,
    zoom: effectiveZoom,
    bearing: effectiveBearing,
    pitch: effectivePitch,
    ...(camera?.transitionDuration
      ? {
          transitionDuration: camera.transitionDuration,
          transitionInterpolator: camera.transitionInterpolator,
        }
      : {}),
  }

  // deck.gl reports every camera change here (drag-rotate, wheel-zoom). Emit only
  // zoom + bearing; pitch is pinned to the current 2D/3D preset so a vertical
  // drag can't tilt, and center is dropped so the view can't pan. Skip frames
  // emitted by an in-flight transition so button/toggle animations play out.
  const handleViewStateChange = (params: ViewStateChangeParameters) => {
    if (params.interactionState?.inTransition) return
    const v = params.viewState as MapViewState
    onCameraChange({
      zoom: clamp(v.zoom, MIN_ZOOM, MAX_ZOOM),
      bearing: v.bearing ?? 0,
      pitch: effectivePitch,
    })
  }

  // +/- buttons: nudge zoom with a short transition, preserving rotation + tilt.
  const nudgeZoom = (delta: number) => {
    onCameraChange({
      zoom: clamp(effectiveZoom + delta, MIN_ZOOM, MAX_ZOOM),
      bearing: effectiveBearing,
      pitch: effectivePitch,
      transitionDuration: 200,
      transitionInterpolator: zoomInterpolator,
    })
  }

  // 2D/3D toggle: swap between the top-down and tilted presets with an eased
  // pitch transition, keeping the current zoom + rotation.
  const setThreeD = (threeD: boolean) => {
    onCameraChange({
      zoom: effectiveZoom,
      bearing: effectiveBearing,
      pitch: threeD ? PITCH_3D : PITCH_2D,
      transitionDuration: 450,
      transitionInterpolator: pitchInterpolator,
    })
  }

  // Probe support once; if it fails, skip deck.gl (avoids the shader-error
  // overlay) and surface the driver's compile log on-screen.
  useEffect(() => {
    if (!terrainShaderSupported()) setWebglFailed(true)
    if (shaderErrors.length) setShaderError(shaderErrors[shaderErrors.length - 1])
    const onErr = (e: Event) => {
      setShaderError((e as CustomEvent<ShaderError>).detail)
      setWebglFailed(true)
    }
    window.addEventListener('uf-shader-error', onErr)
    return () => window.removeEventListener('uf-shader-error', onErr)
  }, [])

  useEffect(() => {
    let alive = true
    setLoadError(null)
    source.load().then(
      (p) => {
        if (alive) setPoints(p)
      },
      (err: unknown) => {
        console.warn(`[urban-flow] failed to load ${source.meta.id}:`, err)
        if (alive) setLoadError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      alive = false
    }
  }, [source])

  // Recompute the heightmap only when the data or the KDE bandwidth changes —
  // color/count tweaks (also in `controls`) must not re-run the expensive KDE.
  // Deferred a frame so the loading label paints before the main thread blocks.
  useEffect(() => {
    if (!points) return
    let alive = true
    const id = setTimeout(() => {
      const hm = computeHeightmap(points, SEOUL_BOUNDS, {
        gridSize: GRID_SIZE,
        sigmaMeters: controls.sigma,
      })
      if (alive) setHeightmap(hm)
    }, 0)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [points, controls.sigma])

  // lil-gui color tuner (opt-in via ?tune). Dynamically imported so it never
  // ships in the main bundle for normal visitors; mirrors widget values into
  // state so the layers re-render live. Created once; torn down on unmount.
  useEffect(() => {
    if (!tuningEnabled()) return
    let gui: { destroy(): void } | undefined
    let cancelled = false
    void import('lil-gui').then(({ default: GUI }) => {
      if (cancelled) return
      const g = new GUI({ title: 'urban flow · tune' })
      gui = g
      const s = { ...DEFAULT_CONTROLS }
      const sync = () => setControls({ ...s })

      const c = g.addFolder('contours')
      c.add(s, 'count', 4, 40, 1).name('line count').onChange(sync)
      c.add(s, 'height', 0, 10000, 100).name('height (m)').onChange(sync)
      c.add(s, 'sigma', 300, 2500, 50).name('KDE σ (m)').onChange(sync)
      c.addColor(s, 'lineColor').name('low color').onChange(sync)
      c.addColor(s, 'peakColor').name('peak color').onChange(sync)
      c.add(s, 'contourOpacity', 0, 1, 0.01).name('opacity').onChange(sync)

      const b = g.addFolder('boundary')
      b.addColor(s, 'boundaryColor').name('line').onChange(sync)
      b.add(s, 'boundaryOpacity', 0, 1, 0.01).name('opacity').onChange(sync)

      const p = g.addFolder('park')
      p.addColor(s, 'parkColor').name('fill').onChange(sync)
      p.add(s, 'parkOpacity', 0, 1, 0.01).name('opacity').onChange(sync)

      const r = g.addFolder('river')
      r.addColor(s, 'riverColor').name('fill').onChange(sync)
      r.add(s, 'riverOpacity', 0, 1, 0.01).name('opacity').onChange(sync)
    })
    return () => {
      cancelled = true
      gui?.destroy()
    }
  }, [])

  const layers = useMemo<Layer[]>(() => {
    if (!heightmap) return []
    // Flat z=0 reference plate under the terrain: Seoul outline, then parks and
    // river; the contour relief (drawn last) sits on top.
    return [
      seoulBoundaryLayer({
        lineColor: hexToRgba(controls.boundaryColor, controls.boundaryOpacity),
        fillColor: [80, 80, 80, 18],
      }),
      parkLayer({ fillColor: hexToRgba(controls.parkColor, controls.parkOpacity) }),
      riverLayer({ fillColor: hexToRgba(controls.riverColor, controls.riverOpacity) }),
      new ContourTerrainLayer({
        id: `terrain-${source.meta.id}`,
        heightmap,
        interval: 1 / controls.count,
        heightScale: controls.height,
        lineColor: hexToRgb(controls.lineColor),
        peakColor: hexToRgb(controls.peakColor),
        opacity: controls.contourOpacity,
      }),
    ]
  }, [heightmap, controls, source.meta.id])

  if (webglFailed) {
    return (
      <>
        <ContourFallback />
        {shaderError && (
          <div className={styles.diag} role="alert">
            <p className={styles.diagTitle}>
              WebGL terrain unavailable · {shaderError.stage} shader compile error
            </p>
            <pre className={styles.diagLog}>{shaderError.log.trim() || '(empty driver log)'}</pre>
          </div>
        )}
      </>
    )
  }

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: '0' }}>
      <DeckGL
        style={{ position: 'absolute', inset: '0' }}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        // Turntable interaction: left-drag rotates (dragMode 'rotate'), scroll /
        // pinch zooms. Pan is disabled so the terrain stays centered; pitch is
        // pinned per 2D/3D preset in handleViewStateChange, so drag only rotates.
        controller={{
          dragMode: 'rotate',
          dragPan: false,
          dragRotate: true,
          touchRotate: true,
          scrollZoom: true,
          touchZoom: true,
          doubleClickZoom: false,
          keyboard: false,
          inertia: 250,
        }}
        layers={layers}
        onError={(error) => {
          // Shader compile/link or context failure on this device — degrade
          // gracefully instead of leaving the panel blank.
          console.warn('[urban-flow] deck.gl terrain failed; using SVG fallback:', error)
          setWebglFailed(true)
        }}
      />
      {heightmap && (
        <>
          <div className={styles.viewToggle} role="group" aria-label="View angle">
            <button
              type="button"
              className={`${styles.viewBtn} ${!is3d ? styles.viewBtnActive : ''}`}
              aria-pressed={!is3d}
              onClick={() => setThreeD(false)}
            >
              2D
            </button>
            <button
              type="button"
              className={`${styles.viewBtn} ${is3d ? styles.viewBtnActive : ''}`}
              aria-pressed={is3d}
              onClick={() => setThreeD(true)}
            >
              3D
            </button>
          </div>
          <div className={styles.zoomControls}>
            <button
              type="button"
              className={styles.zoomBtn}
              aria-label="Zoom in"
              onClick={() => nudgeZoom(ZOOM_STEP)}
              disabled={effectiveZoom >= MAX_ZOOM}
            >
              +
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              aria-label="Zoom out"
              onClick={() => nudgeZoom(-ZOOM_STEP)}
              disabled={effectiveZoom <= MIN_ZOOM}
            >
              −
            </button>
          </div>
        </>
      )}
      {!heightmap && (
        <div className={styles.loading} role="status">
          {loadError ? `Failed to load data — ${loadError}` : 'Building terrain…'}
        </div>
      )}
    </div>
  )
}
