import { useRef, useState } from 'react'
import { Container, Section, Eyebrow } from '../ui/layout'
import { SOURCES } from '../data/sources'
import type { DataSource } from '../data/types'
import { TerrainPanel } from './TerrainPanel'
import styles from './Dashboard.module.css'

/** Hard cap: up to 6 contour-terrain panels on screen (WebGL context budget). */
const MAX_PANELS = 6

type PanelEntry = {
  /** Stable React key — survives removals, unlike an array index. */
  key: number
  source: DataSource
}

/**
 * Dashboard section — the interactive comparison surface. Starts with one
 * contour-terrain panel and grows as the user adds datasets (cycling through
 * the registry, duplicates allowed) up to MAX_PANELS. The global particle
 * budget is re-split across panels on every add/remove (see particleBudget.ts).
 */
export function Dashboard() {
  const nextKey = useRef(1)
  const [panels, setPanels] = useState<PanelEntry[]>([{ key: 0, source: SOURCES[0] }])

  const addPanel = () => {
    setPanels((prev) => {
      if (prev.length >= MAX_PANELS) return prev
      // Prefer a dataset not on screen yet; once all are shown, cycle.
      const unused = SOURCES.find((s) => !prev.some((p) => p.source.meta.id === s.meta.id))
      const source = unused ?? SOURCES[prev.length % SOURCES.length]
      return [...prev, { key: nextKey.current++, source }]
    })
  }

  const removePanel = (key: number) => {
    setPanels((prev) => (prev.length > 1 ? prev.filter((p) => p.key !== key) : prev))
  }

  const atCap = panels.length >= MAX_PANELS

  return (
    <Section id="dashboard" divided>
      <Container>
        <Eyebrow>Dashboard</Eyebrow>
        <h2 className={styles.headline}>Compare contours and particles side by side</h2>
        <p className={styles.lead}>
          Each panel renders one dataset as contour terrain with particles flowing over it.
          Add datasets to compare side by side — up to six panels.
        </p>

        <div className={panels.length === 1 ? styles.panels : styles.panelsGrid}>
          {panels.map(({ key, source }) => (
            <article className={styles.panel} key={key}>
              <header className={styles.panelHead}>
                <span className={styles.dot} aria-hidden="true" />
                <div className={styles.panelTitleGroup}>
                  <h3 className={styles.panelTitle}>{source.meta.label}</h3>
                  <p className={styles.panelSub}>{source.meta.description}</p>
                </div>
                {panels.length > 1 && (
                  <button
                    className={styles.removePanel}
                    type="button"
                    onClick={() => removePanel(key)}
                    aria-label={`Remove ${source.meta.label} panel`}
                  >
                    ✕
                  </button>
                )}
              </header>

              <div className={styles.canvas}>
                <TerrainPanel source={source} activePanels={panels.length} />
              </div>

              <footer className={styles.panelMeta}>
                <span>Unit · {source.meta.unit}</span>
                <span>Contour terrain (KDE) · GPU particle flow</span>
              </footer>
            </article>
          ))}

          <button
            className={styles.addPanel}
            type="button"
            disabled={atCap}
            onClick={addPanel}
          >
            <span className={styles.plus} aria-hidden="true">
              +
            </span>
            <span className={styles.addLabel}>Add a dataset</span>
            <span className={styles.addHint}>
              {atCap ? 'Maximum of 6 panels' : `${panels.length} of ${MAX_PANELS} panels`}
            </span>
          </button>
        </div>
      </Container>
    </Section>
  )
}
