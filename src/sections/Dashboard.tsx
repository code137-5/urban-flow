import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Container, Section, Eyebrow } from '../ui/layout'
import { DEFAULT_SOURCE, getSource } from '../data/sources'
import type { DatasetId } from '../data/types'
import { TerrainPanel } from './TerrainPanel'
import styles from './Dashboard.module.css'

/**
 * A dashboard panel is described by a stable key plus the id of the dataset it
 * shows. The key is a monotonically-increasing counter (never Math.random /
 * Date.now — those break reconciliation and are forbidden in this env), so React
 * keeps each panel's deck.gl instance stable across add/remove. `sourceId`
 * drives which `DataSource` the panel renders and its header copy; Task 4 will
 * make it user-selectable via a dropdown.
 */
interface PanelDescriptor {
  key: number
  sourceId: DatasetId
}

/** Two full rows of three. */
const MAX_PANELS = 6

/**
 * Carbon responsive column cap by viewport width (md = 672, lg = 1056):
 * mobile → 1, tablet → 2, desktop → up to 3. The actual column count is then
 * `min(cap, itemCount)` so the grid never leaves empty stretched tracks.
 */
function columnCapForWidth(width: number): number {
  if (width <= 672) return 1
  if (width <= 1056) return 2
  return 3
}

/** Track viewport width so the grid re-picks its column count on resize. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  )
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/**
 * Dashboard section — the interactive comparison surface (P5).
 *
 * Starts with one real contour-terrain panel (deck.gl, technique from
 * Aete/seoul-terrain-animation) and grows: "Add a dataset" appends panels into a
 * responsive grid that caps at 3 columns and wraps onto new rows (up to 6 panels
 * total). Panels are removable down to a minimum of one.
 */
export function Dashboard() {
  const [panels, setPanels] = useState<PanelDescriptor[]>(() => [
    { key: 0, sourceId: DEFAULT_SOURCE.meta.id },
  ])
  // Next stable key to hand out. Kept in a ref so it survives re-renders without
  // triggering one; StrictMode may skip a value, which is harmless (uniqueness,
  // not contiguity, is what matters for React keys).
  const nextKey = useRef(1)

  const width = useViewportWidth()
  const canAdd = panels.length < MAX_PANELS

  const addPanel = () => {
    setPanels((prev) => {
      if (prev.length >= MAX_PANELS) return prev
      const key = nextKey.current
      nextKey.current += 1
      return [...prev, { key, sourceId: DEFAULT_SOURCE.meta.id }]
    })
  }

  const removePanel = (key: number) => {
    // Keep at least one panel so the dashboard is never empty.
    setPanels((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.key !== key)))
  }

  // Grid children = panels + (the trailing add tile, when below the cap). Column
  // count is min(width cap, children) so panels stay readable and never overflow.
  const itemCount = panels.length + (canAdd ? 1 : 0)
  const columns = Math.max(1, Math.min(columnCapForWidth(width), itemCount))
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
  }

  return (
    <Section id="dashboard" divided>
      <Container>
        <Eyebrow>Dashboard</Eyebrow>
        <h2 className={styles.headline}>Compare contours and particles side by side</h2>
        <p className={styles.lead}>
          Add datasets to build a live comparison. The grid starts with one panel and grows to
          three across, then wraps to a second row — up to six panels. Remove any panel to refocus.
        </p>

        <div className={styles.panels} style={gridStyle}>
          {panels.map((panel) => {
            const source = getSource(panel.sourceId) ?? DEFAULT_SOURCE
            const { meta } = source
            return (
              <article className={styles.panel} key={panel.key}>
                <header className={styles.panelHead}>
                  <span className={styles.dot} aria-hidden="true" />
                  <div className={styles.panelTitleGroup}>
                    {/* Task 4: dataset dropdown goes here — this slot will hold a
                        <select> of SOURCES; for now it shows the source label as
                        static text driven by the descriptor's sourceId. */}
                    <div className={styles.selectorSlot}>
                      <h3 className={styles.panelTitle}>{meta.label}</h3>
                    </div>
                    <p className={styles.panelSub}>{meta.description}</p>
                  </div>
                  <button
                    className={styles.remove}
                    type="button"
                    onClick={() => removePanel(panel.key)}
                    disabled={panels.length <= 1}
                    aria-label={`Remove ${meta.label} panel`}
                    title={panels.length <= 1 ? 'At least one panel is required' : 'Remove panel'}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </header>

                <div className={styles.canvas}>
                  <TerrainPanel source={source} />
                </div>

                <footer className={styles.panelMeta}>
                  <span>Unit · {meta.unit}</span>
                  <span>Contour terrain (KDE) · particles coming soon</span>
                </footer>
              </article>
            )
          })}

          {canAdd ? (
            <button className={styles.addPanel} type="button" onClick={addPanel}>
              <span className={styles.plus} aria-hidden="true">
                +
              </span>
              <span className={styles.addLabel}>Add a dataset</span>
              <span className={styles.addHint}>Up to {MAX_PANELS} panels</span>
            </button>
          ) : (
            <div className={`${styles.addPanel} ${styles.addPanelMax}`} aria-disabled="true">
              <span className={styles.addLabel}>Maximum reached</span>
              <span className={styles.addHint}>{MAX_PANELS} panels is the limit</span>
            </div>
          )}
        </div>
      </Container>
    </Section>
  )
}
