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
            서울의 지형과 흐름을 등고선과 입자로 시각화합니다.
          </p>
        </div>
        <div className={styles.meta}>
          <p className={styles.credit}>데이터 · 서울 열린데이터광장</p>
          <p className={styles.credit}>
            Based on{' '}
            <a className={styles.link} href={REPO_URL} target="_blank" rel="noreferrer">
              Aete/seoul-terrain-animation
            </a>
          </p>
          <p className={styles.copyright}>© 2026 Urban Flow</p>
        </div>
      </div>
    </footer>
  )
}
