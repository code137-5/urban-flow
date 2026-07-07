import styles from './TopNav.module.css'

/**
 * Sticky top navigation chrome (Carbon Gray 100 dark).
 * Left: "Urban Flow" wordmark. Right: section anchors + GitHub external link.
 * Below 672px the text links collapse and only the wordmark remains.
 */
export function TopNav() {
  return (
    <header className={styles.nav}>
      <div className={styles.inner}>
        <a className={styles.wordmark} href="#top" aria-label="Urban Flow — 맨 위로">
          Urban <span className={styles.accent}>Flow</span>
        </a>
        <nav className={styles.links} aria-label="주요 메뉴">
          <a className={styles.link} href="#about">
            소개
          </a>
          <a className={styles.link} href="#dashboard">
            대시보드
          </a>
          <a
            className={styles.link}
            href="https://github.com/Aete/seoul-terrain-animation"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>
      </div>
    </header>
  )
}
