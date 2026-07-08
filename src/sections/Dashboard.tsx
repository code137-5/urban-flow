import { Container, Section, Eyebrow } from '../ui/layout'
import { DEFAULT_SOURCE } from '../data/sources'
import { TerrainPanel } from './TerrainPanel'
import styles from './Dashboard.module.css'

/**
 * Dashboard section — the interactive comparison surface (built out in P5).
 * For now it renders one real contour-terrain panel (deck.gl, technique from
 * Aete/seoul-terrain-animation) plus a disabled "add dataset" tile to hint the
 * 1 → 2 → 3 panel growth.
 */
export function Dashboard() {
  const { meta } = DEFAULT_SOURCE

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
                <h3 className={styles.panelTitle}>{meta.label}</h3>
                <p className={styles.panelSub}>{meta.description}</p>
              </div>
              <span className={styles.tag}>Preview</span>
            </header>

            <div className={styles.canvas}>
              <TerrainPanel source={DEFAULT_SOURCE} />
            </div>

            <footer className={styles.panelMeta}>
              <span>Unit · {meta.unit}</span>
              <span>Contour terrain (KDE) · particles coming soon</span>
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
