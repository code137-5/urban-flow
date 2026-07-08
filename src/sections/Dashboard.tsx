import { Container, Section, Eyebrow } from '../ui/layout'
import styles from './Dashboard.module.css'

/**
 * A single density "peak" — a cluster of nested contour rings. Rings share one
 * angular wobble so they never cross, reading as a topographic elevation map.
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

/** Stand-in density peaks (downtown + two secondary centers) for the preview. */
const PEAKS: Peak[] = [
  { cx: 305, cy: 172, r0: 16, rings: 10, step: 15, freq: [3, 2, 5], amp: 0.1, phase: 0.6 },
  { cx: 148, cy: 138, r0: 13, rings: 7, step: 14, freq: [2, 4, 3], amp: 0.13, phase: 2.1 },
  { cx: 208, cy: 270, r0: 10, rings: 5, step: 12, freq: [4, 3, 2], amp: 0.11, phase: 4.0 },
]

/** Deterministic wobbly closed contour ring at a given base radius. */
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

/** Interpolate border-subtle (low elevation) → IBM Blue 40 (high elevation). */
function elevationColor(e: number): string {
  const low = [57, 57, 57] // --border-subtle #393939
  const high = [120, 169, 255] // --link #78a9ff
  const c = low.map((v, i) => Math.round(v + (high[i] - v) * e))
  return `rgb(${c[0]} ${c[1]} ${c[2]})`
}

/**
 * Procedurally-drawn contour terrain — a placeholder for the real
 * deck.gl contour + particle render (built in P3–P4). Purely decorative.
 */
function ContourTerrain() {
  return (
    <svg
      className={styles.terrain}
      viewBox="0 0 480 360"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      strokeWidth="1"
      aria-hidden="true"
      focusable="false"
    >
      {PEAKS.flatMap((p, pi) =>
        Array.from({ length: p.rings }, (_, k) => {
          // Draw outer (low) rings first so inner blue peaks sit on top.
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

/**
 * Dashboard section — the interactive comparison surface (built out in P5).
 * For now it shows a single contour-terrain panel as a placeholder, plus a
 * disabled "add dataset" tile to hint the 1 → 2 → 3 panel growth.
 */
export function Dashboard() {
  return (
    <Section id="dashboard" divided>
      <Container>
        <Eyebrow>Dashboard</Eyebrow>
        <h2 className={styles.headline}>Compare contours and particles side by side</h2>
        <p className={styles.lead}>
          An interactive comparison dashboard that starts with a single panel and grows to two
          or three as you add datasets will live here. Below is a preview of one panel.
        </p>

        <div className={styles.panels}>
          <article className={styles.panel}>
            <header className={styles.panelHead}>
              <span className={styles.dot} aria-hidden="true" />
              <div className={styles.panelTitleGroup}>
                <h3 className={styles.panelTitle}>Ttareungi (public bike)</h3>
                <p className={styles.panelSub}>Seoul density as contour terrain</p>
              </div>
              <span className={styles.tag}>Preview</span>
            </header>

            <div className={styles.canvas}>
              <ContourTerrain />
            </div>

            <footer className={styles.panelMeta}>
              <span>Unit · rentals</span>
              <span>Contour + particle render — coming soon</span>
            </footer>
          </article>

          <button className={styles.addPanel} type="button" disabled>
            <span className={styles.plus} aria-hidden="true">
              +
            </span>
            <span className={styles.addLabel}>Add a dataset</span>
            <span className={styles.addHint}>Grows to 2–3 panels</span>
          </button>
        </div>
      </Container>
    </Section>
  )
}
