import { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { LinearInterpolator } from '@deck.gl/core'
import type { Layer, MapViewState, ViewStateChangeParameters } from '@deck.gl/core'
import { INITIAL_VIEW_STATE, SEOUL_BOUNDS, fitSeoulViewState } from '../config'
import { computeHeightmap } from '../data/field'
import ContourTerrainLayer from '../layers/ContourTerrainLayer'
import ParticleLayer from '../layers/ParticleLayer'
import { seoulBoundaryLayer } from '../layers/seoulBoundaryLayer'
import { parkLayer, riverLayer } from '../layers/featureOverlays'
import { ContourFallback } from './ContourFallback'
import { terrainShaderSupported } from '../layers/terrainSupport'
import { particlesSupported } from '../layers/particleSupport'
import { detectGpuTier, perPanelParticleCount } from '../layers/particleBudget'
import { usePanelVisibility } from '../hooks/usePanelVisibility'
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

// Interaction bounds. Users may pan, zoom, rotate (bearing), AND free-tilt
// (drag pitch) — full free camera control. Pan is soft-bounded: the center is
// clamped to SEOUL_BOUNDS so the city can't be dragged out of frame. The 2D/3D
// toggle still jumps between the two pitch presets as shortcuts.
const MIN_ZOOM = 9
const MAX_ZOOM = 14
const ZOOM_STEP = 0.6
const MAX_PITCH = 60
const PITCH_3D = 60 // the tilted "contour poster" look
const PITCH_2D = 0 // top-down plan view

const [BOUND_MIN_LNG, BOUND_MIN_LAT, BOUND_MAX_LNG, BOUND_MAX_LAT] = SEOUL_BOUNDS

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Soft pan bound: keep the camera center inside Seoul's bounding box so at least
// the near half of the city stays framed no matter how far the user drags.
const clampCenter = (lng: number, lat: number): [number, number] => [
  clamp(lng, BOUND_MIN_LNG, BOUND_MAX_LNG),
  clamp(lat, BOUND_MIN_LAT, BOUND_MAX_LAT),
]

// Eased transitions: +/- buttons animate zoom; the 2D/3D toggle animates tilt.
const zoomInterpolator = new LinearInterpolator(['zoom'])
const pitchInterpolator = new LinearInterpolator(['pitch'])

/**
 * The user-controllable camera params for a panel: center (longitude/latitude),
 * zoom, bearing (rotation), and pitch (2D↔3D). Center is soft-clamped to
 * SEOUL_BOUNDS (see clampCenter) so a pan can't push Seoul out of frame. A null
 * PanelCamera means "use the size-fitted view" — the default and reset state.
 * Shared verbatim across panels when the dashboard's "sync views" option is on,
 * so linked panels pan/zoom/rotate together. Optional transition props ride along
 * so a button/toggle change animates.
 */
export type PanelCamera = {
  longitude: number
  latitude: number
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
  lineWidth: number
  capOpacity: number
  lineColor: string
  peakColor: string
  contourOpacity: number
  boundaryColor: string
  boundaryOpacity: number
  parkColor: string
  parkOpacity: number
  riverColor: string
  riverOpacity: number
  particlesOn: boolean
  particleCount: number
  particleSpeed: number
  particleJitter: number
  particleFlowBlend: number
  particleSize: number
  particleGlow: number
  particleTrail: number
  particleTrailLength: number
  particleTrailGap: number
  particleColor: string
  particleOpacity: number
  particleMaxAge: number
}

const DEFAULT_CONTROLS: Controls = {
  count: 16,
  height: 4000,
  // KDE bandwidth (m). ~1800m makes the field read as continuous terrain
  // rather than isolated peaks over flat ground (tuned in the reference).
  sigma: 1800,
  // Contour half-width in interval units (hairline look, tuned by the user);
  // the shader keeps thickness slope-invariant, this scales it overall.
  lineWidth: 0.01,
  // Saturated summit plateau (마루) opacity — 0 removes the filled cap.
  capOpacity: 0.2,
  lineColor: '#393939', // low elevation — dark hairline gray
  peakColor: '#c6c6c6', // high elevation — light gray
  contourOpacity: 1,
  boundaryColor: '#525252',
  boundaryOpacity: 0.67,
  parkColor: '#819c89', // muted gray-green
  parkOpacity: 0.13,
  riverColor: '#9aa9b7', // desaturated steel gray
  riverOpacity: 0.42,
  particlesOn: true,
  particleCount: 1000,
  particleSpeed: 1000,
  particleJitter: 0,
  particleFlowBlend: 0, // 0 = flow along contour lines, 1 = straight uphill
  particleSize: 4.5,
  particleGlow: 0.6, // halo strength — overlapping particles bloom additively
  particleTrail: 0.7, // ghost-afterimage strength (0 = off)
  particleTrailLength: 8, // ghost snapshots in the trail
  particleTrailGap: 6, // sim steps between snapshots (spacing)
  particleColor: '#ff8880', // warm coral — pops against the cool monochrome terrain
  particleOpacity: 0.85,
  particleMaxAge: 800,
}

// Cap the canvas backing-store resolution: 6 panels at DPR 3 is what actually
// kills mobile tabs, not particle counts.
const DPR_CAP =
  typeof window === 'undefined'
    ? 1
    : Math.min(window.devicePixelRatio || 1, detectGpuTier() === 'mobile' ? 1.5 : 2)

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

// With multiple panels mounted, only the first one owns the (dev-only) tuner —
// six identical lil-gui instances stacked on screen help no one.
let tunerActive = false

/** Crosshair glyph for the "reset view" control — re-centers/re-fits the camera. */
function RecenterIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="3.25" />
      <path d="M8 1v2.25M8 12.75V15M1 8h2.25M12.75 8H15" strokeLinecap="square" />
    </svg>
  )
}

/**
 * A single dashboard panel: real deck.gl contour terrain for one `DataSource`,
 * with GPU particles flowing over it (ParticleLayer). The KDE heightmap + Seoul
 * mask are computed once (deferred a frame so the loading state paints first),
 * then rendered at the pitched Seoul view. Colors come from `Controls` and are
 * live-tunable via lil-gui.
 *
 * The camera is controlled: `camera` (center/zoom/bearing/pitch) is merged onto
 * the size-fitted view, and every change is reported via `onCameraChange`. The
 * dashboard owns this state so it can mirror one panel's camera across all
 * panels ("sync views"). A null `camera` means "use the fit".
 */
export function TerrainPanel({
  source,
  activePanels = 1,
  camera,
  onCameraChange,
  onResetCamera,
}: {
  source: DataSource
  /** Live panel count — splits the global particle budget (particleBudget.ts). */
  activePanels?: number
  camera: PanelCamera | null
  onCameraChange: (camera: PanelCamera) => void
  onResetCamera: () => void
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
  // Particle probe result. Failure disables ONLY the particles — the terrain
  // still renders (never the SVG fallback for a particle-only failure).
  const [particlesOk, setParticlesOk] = useState(true)
  // Pause simulation while the panel is off-screen / tab hidden / reduced motion.
  const { ref: visibilityRef, animate } = usePanelVisibility()

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
  // size-fitted default. Center now rides along too (clamped to Seoul), so a pan
  // moves the view while the fit still supplies the default/reset framing.
  const effectiveLng = camera?.longitude ?? fittedView.longitude
  const effectiveLat = camera?.latitude ?? fittedView.latitude
  const effectiveZoom = camera?.zoom ?? fittedView.zoom
  const effectiveBearing = camera?.bearing ?? fittedView.bearing ?? 0
  const effectivePitch = camera?.pitch ?? fittedView.pitch ?? PITCH_3D
  const is3d = effectivePitch > 0

  const viewState: MapViewState = {
    ...fittedView,
    longitude: effectiveLng,
    latitude: effectiveLat,
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

  // deck.gl reports every camera change here (drag-pan, drag-rotate, wheel-zoom,
  // drag-tilt). Emit center (clamped to Seoul), zoom, bearing, and pitch —
  // free-tilt is allowed, clamped to [0, MAX_PITCH]. Skip frames emitted by an
  // in-flight transition so button/toggle animations play out.
  const handleViewStateChange = (params: ViewStateChangeParameters) => {
    if (params.interactionState?.inTransition) return
    const v = params.viewState as MapViewState
    const [longitude, latitude] = clampCenter(v.longitude, v.latitude)
    onCameraChange({
      longitude,
      latitude,
      zoom: clamp(v.zoom, MIN_ZOOM, MAX_ZOOM),
      bearing: v.bearing ?? 0,
      pitch: clamp(v.pitch ?? effectivePitch, 0, MAX_PITCH),
    })
  }

  // +/- buttons: nudge zoom with a short transition, preserving pan + rotation + tilt.
  const nudgeZoom = (delta: number) => {
    onCameraChange({
      longitude: effectiveLng,
      latitude: effectiveLat,
      zoom: clamp(effectiveZoom + delta, MIN_ZOOM, MAX_ZOOM),
      bearing: effectiveBearing,
      pitch: effectivePitch,
      transitionDuration: 200,
      transitionInterpolator: zoomInterpolator,
    })
  }

  // 2D/3D toggle: swap between the top-down and tilted presets with an eased
  // pitch transition, keeping the current pan + zoom + rotation.
  const setThreeD = (threeD: boolean) => {
    onCameraChange({
      longitude: effectiveLng,
      latitude: effectiveLat,
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
    if (!particlesSupported()) setParticlesOk(false)
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
    if (!tuningEnabled() || tunerActive) return
    tunerActive = true
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
      c.add(s, 'lineWidth', 0.005, 0.15, 0.005).name('line width').onChange(sync)
      c.add(s, 'capOpacity', 0, 1, 0.05).name('peak cap opacity').onChange(sync)
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

      const pt = g.addFolder('particles')
      pt.add(s, 'particlesOn').name('enabled').onChange(sync)
      pt.add(s, 'particleCount', 500, 8000, 500).name('count').onChange(sync)
      pt.add(s, 'particleSpeed', 0, 2000, 50).name('speed (m/s)').onChange(sync)
      pt.add(s, 'particleJitter', 0, 1, 0.05).name('jitter').onChange(sync)
      pt.add(s, 'particleFlowBlend', 0, 1, 0.05).name('flow → uphill').onChange(sync)
      pt.add(s, 'particleSize', 1, 8, 0.5).name('size (px)').onChange(sync)
      pt.add(s, 'particleGlow', 0, 1, 0.05).name('glow').onChange(sync)
      pt.add(s, 'particleTrail', 0, 1, 0.05).name('trail opacity').onChange(sync)
      pt.add(s, 'particleTrailLength', 1, 12, 1).name('trail length').onChange(sync)
      pt.add(s, 'particleTrailGap', 1, 12, 1).name('trail gap (steps)').onChange(sync)
      pt.addColor(s, 'particleColor').name('color').onChange(sync)
      pt.add(s, 'particleOpacity', 0, 1, 0.05).name('opacity').onChange(sync)
      pt.add(s, 'particleMaxAge', 60, 900, 30).name('lifetime (frames)').onChange(sync)
    })
    return () => {
      cancelled = true
      gui?.destroy()
      tunerActive = false
    }
  }, [])

  const layers = useMemo<Layer[]>(() => {
    if (!heightmap) return []
    // Flat z=0 reference plate under the terrain: Seoul outline, then parks and
    // river; the contour relief sits on top, with particles above it.
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
        lineWidth: controls.lineWidth,
        capOpacity: controls.capOpacity,
        lineColor: hexToRgb(controls.lineColor),
        peakColor: hexToRgb(controls.peakColor),
        opacity: controls.contourOpacity,
      }),
      ...(particlesOk && controls.particlesOn
        ? [
            new ParticleLayer({
              id: `particles-${source.meta.id}`,
              heightmap,
              numParticles: perPanelParticleCount(activePanels, controls.particleCount),
              // Same knob as the terrain layer → particles always sit on the surface.
              heightScale: controls.height,
              speed: controls.particleSpeed,
              jitter: controls.particleJitter,
              flowBlend: controls.particleFlowBlend,
              maxAge: controls.particleMaxAge,
              pointSize: controls.particleSize,
              glow: controls.particleGlow,
              trail: controls.particleTrail,
              trailLength: controls.particleTrailLength,
              trailGap: controls.particleTrailGap,
              color: hexToRgb(controls.particleColor),
              opacity: controls.particleOpacity,
              animate,
            }),
          ]
        : []),
    ]
  }, [heightmap, controls, source.meta.id, particlesOk, animate, activePanels])

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
      {/* Visibility sentinel: fills the panel so the IntersectionObserver can
          pause the particle simulation when the panel scrolls off-screen. */}
      <div
        ref={visibilityRef}
        style={{ position: 'absolute', inset: '0', pointerEvents: 'none' }}
        aria-hidden="true"
      />
      <DeckGL
        style={{ position: 'absolute', inset: '0' }}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        useDevicePixels={DPR_CAP}
        // Interaction: left-drag pans (dragMode 'pan'), ⌘/Ctrl- or right-drag
        // rotates bearing AND tilts pitch (free tilt, clamped in
        // handleViewStateChange), scroll / pinch zooms, double-click zooms in.
        // Pan is soft-clamped to Seoul in handleViewStateChange.
        controller={{
          dragMode: 'pan',
          dragPan: true,
          dragRotate: true,
          touchRotate: true,
          scrollZoom: true,
          touchZoom: true,
          doubleClickZoom: true,
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
            <button
              type="button"
              className={styles.zoomBtn}
              aria-label="Reset view"
              title="Reset view"
              onClick={onResetCamera}
              disabled={camera === null}
            >
              <RecenterIcon />
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
