import styles from './Dashboard.module.css'

/**
 * Zero-WebGL fallback for the contour terrain: a procedurally-drawn SVG contour
 * motif. Shown when deck.gl fails to initialize/compile on a device (see
 * TerrainPanel's onError), so the panel is never blank.
 */
interface Peak {
  cx: number
  cy: number
  r0: number
  rings: number
  step: number
  freq: [number, number, number]
  amp: number
  phase: number
}

const PEAKS: Peak[] = [
  { cx: 305, cy: 172, r0: 16, rings: 10, step: 15, freq: [3, 2, 5], amp: 0.1, phase: 0.6 },
  { cx: 148, cy: 138, r0: 13, rings: 7, step: 14, freq: [2, 4, 3], amp: 0.13, phase: 2.1 },
  { cx: 208, cy: 270, r0: 10, rings: 5, step: 12, freq: [4, 3, 2], amp: 0.11, phase: 4.0 },
]

function ringPath(p: Peak, radius: number): string {
  const steps = 60
  let d = ''
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const w =
      1 +
      p.amp *
        (Math.sin(t * p.freq[0] + p.phase) +
          0.6 * Math.sin(t * p.freq[1] - p.phase) +
          0.4 * Math.sin(t * p.freq[2] + p.phase * 2))
    const x = p.cx + Math.cos(t) * radius * w
    const y = p.cy + Math.sin(t) * radius * w * 0.82
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `
  }
  return `${d}Z`
}

/** Interpolate hairline gray (low) → light gray (high), matching the terrain ramp. */
function elevationColor(e: number): string {
  const low = [57, 57, 57] // --border-subtle
  const high = [198, 198, 198] // --text-secondary
  const c = low.map((v, i) => Math.round(v + (high[i] - v) * e))
  return `rgb(${c[0]} ${c[1]} ${c[2]})`
}

export function ContourFallback() {
  return (
    <svg
      className={styles.fallback}
      viewBox="0 0 480 360"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      strokeWidth="1"
      aria-hidden="true"
      focusable="false"
    >
      {PEAKS.flatMap((p, pi) =>
        Array.from({ length: p.rings }, (_, k) => {
          const ring = p.rings - 1 - k
          const radius = p.r0 + ring * p.step
          const e = p.rings === 1 ? 1 : 1 - ring / (p.rings - 1)
          return (
            <path
              key={`${pi}-${ring}`}
              d={ringPath(p, radius)}
              stroke={elevationColor(e)}
              strokeWidth={e > 0.66 ? 1.4 : 1}
              strokeOpacity={0.45 + e * 0.55}
            />
          )
        }),
      )}
    </svg>
  )
}
