import { Button } from '../ui/Button'
import { Container, Eyebrow } from '../ui/layout'
import styles from './Hero.module.css'

/** Inline arrow glyph for the primary CTA's trailing adornment. */
function ArrowRight() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" strokeLinecap="square" />
    </svg>
  )
}

/** Hero — the opening statement of Urban Flow. */
export function Hero() {
  return (
    <div className={styles.hero}>
      <Container>
        <div className={styles.content}>
          <Eyebrow>Seoul, read as terrain</Eyebrow>

          <h1 className={styles.headline}>Urban Flow</h1>

          <p className={styles.subhead}>
            Seoul's daily rhythm, rendered as contour-line terrain with GPU
            particles flowing over it. Stack bike-share, population movement, and
            subway data into a living landscape — and compare how the city breathes,
            all on one screen.
          </p>

          <div className={styles.actions}>
            <Button variant="primary" href="#dashboard" trailing={<ArrowRight />}>
              Explore the dashboard
            </Button>
            <Button variant="tertiary" href="#about">
              About the project
            </Button>
          </div>
        </div>
      </Container>
    </div>
  )
}
