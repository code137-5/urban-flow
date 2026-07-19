import { useEffect, useMemo, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { Layer } from '@deck.gl/core'
import { INITIAL_VIEW_STATE, SEOUL_BOUNDS } from '../config'
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

// The shared INITIAL_VIEW_STATE frames Seoul for a full-screen canvas; inside a
// bounded panel it reads low, so tighten zoom and drop the center a touch to fill.
const PANEL_VIEW_STATE = {
  ...INITIAL_VIEW_STATE,
  latitude: 37.535,
  zoom: 10.9,
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
  particlesOn: boolean
  particleCount: number
  particleSpeed: number
  particleJitter: number
  particleFlowBlend: number
  particleSize: number
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
  lineColor: '#393939', // low elevation — dark hairline gray
  peakColor: '#c6c6c6', // high elevation — light gray
  contourOpacity: 1,
  boundaryColor: '#525252',
  boundaryOpacity: 0.67,
  parkColor: '#4e5e52', // muted sage
  parkOpacity: 0.26,
  riverColor: '#4a80b0', // saturated slate-blue — the one accent color
  riverOpacity: 0.42,
  particlesOn: true,
  particleCount: 4000,
  particleSpeed: 600,
  particleJitter: 0.25,
  particleFlowBlend: 0, // 0 = flow along contour lines, 1 = straight uphill
  particleSize: 3,
  particleColor: '#78a9ff', // IBM Blue 40 — the design system's one accent
  particleOpacity: 0.85,
  particleMaxAge: 300,
}

// Cap the canvas backing-store resolution: 6 future panels at DPR 3 is what
// actually kills mobile tabs, not particle counts.
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

/**
 * A single dashboard panel: real deck.gl contour terrain for one `DataSource`.
 * The KDE heightmap + Seoul mask are computed once (deferred a frame so the
 * loading state paints first), then rendered as a static "contour poster" at the
 * pitched Seoul view. Colors come from `Controls` and are live-tunable via lil-gui.
 */
export function TerrainPanel({ source }: { source: DataSource }) {
  const [points, setPoints] = useState<GeoPoint[] | null>(null)
  const [heightmap, setHeightmap] = useState<Heightmap | null>(null)
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
    source.load().then((p) => {
      if (alive) setPoints(p)
    })
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

      const pt = g.addFolder('particles')
      pt.add(s, 'particlesOn').name('enabled').onChange(sync)
      pt.add(s, 'particleCount', 500, 8000, 500).name('count').onChange(sync)
      pt.add(s, 'particleSpeed', 0, 2000, 50).name('speed (m/s)').onChange(sync)
      pt.add(s, 'particleJitter', 0, 1, 0.05).name('jitter').onChange(sync)
      pt.add(s, 'particleFlowBlend', 0, 1, 0.05).name('flow → uphill').onChange(sync)
      pt.add(s, 'particleSize', 1, 8, 0.5).name('size (px)').onChange(sync)
      pt.addColor(s, 'particleColor').name('color').onChange(sync)
      pt.add(s, 'particleOpacity', 0, 1, 0.05).name('opacity').onChange(sync)
      pt.add(s, 'particleMaxAge', 60, 900, 30).name('lifetime (frames)').onChange(sync)
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
      ...(particlesOk && controls.particlesOn
        ? [
            new ParticleLayer({
              id: `particles-${source.meta.id}`,
              heightmap,
              numParticles: perPanelParticleCount(1, controls.particleCount),
              // Same knob as the terrain layer → particles always sit on the surface.
              heightScale: controls.height,
              speed: controls.particleSpeed,
              jitter: controls.particleJitter,
              flowBlend: controls.particleFlowBlend,
              maxAge: controls.particleMaxAge,
              pointSize: controls.particleSize,
              color: hexToRgb(controls.particleColor),
              opacity: controls.particleOpacity,
              animate,
            }),
          ]
        : []),
    ]
  }, [heightmap, controls, source.meta.id, particlesOk, animate])

  if (webglFailed) {
    return (
      <>
        <ContourFallback />
        {shaderError && (
          <div className={styles.diag} role="status">
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
    <>
      {/* Visibility sentinel: fills the panel so the IntersectionObserver can
          pause the particle simulation when the panel scrolls off-screen. */}
      <div ref={visibilityRef} style={{ position: 'absolute', inset: '0' }} aria-hidden="true" />
      <DeckGL
        style={{ position: 'absolute', inset: '0' }}
        viewState={PANEL_VIEW_STATE}
        controller={false}
        layers={layers}
        useDevicePixels={DPR_CAP}
        onError={(error) => {
          // Shader compile/link or context failure on this device — degrade
          // gracefully instead of leaving the panel blank.
          console.warn('[urban-flow] deck.gl terrain failed; using SVG fallback:', error)
          setWebglFailed(true)
        }}
      />
      {!heightmap && (
        <div className={styles.loading} role="status">
          Building terrain…
        </div>
      )}
    </>
  )
}
