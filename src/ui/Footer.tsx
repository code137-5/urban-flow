import styles from './Footer.module.css'

const REPO_URL = 'https://github.com/Aete/seoul-terrain-animation'

/**
 * Full-width page footer (Carbon Gray 100 dark).
 * Wordmark + tagline, data-source credit, project attribution, copyright.
 */
export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <p className={styles.wordmark}>
            Urban <span className={styles.accent}>Flow</span>
          </p>
          <p className={styles.tagline}>
            Visualizing Seoul’s terrain and flow with contour lines and particles.
          </p>
        </div>
        <div className={styles.meta}>
          <p className={styles.credit}>Data · Seoul Open Data Plaza</p>
          <p className={styles.credit}>
            Based on{' '}
            <a className={styles.link} href={REPO_URL} target="_blank" rel="noreferrer">
              Aete/seoul-terrain-animation
            </a>
          </p>
          <p className={styles.copyright}>© 2026 Seunggyun Han</p>
        </div>
      </div>
    </footer>
  )
}
