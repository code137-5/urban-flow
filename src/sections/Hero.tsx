import { Button } from '../ui/Button'
import { Container, Eyebrow } from '../ui/layout'
import styles from './Hero.module.css'

/** Low-opacity topographic contour motif — inline so it inherits theme tokens. */
function ContourMotif() {
  return (
    <svg
      className={styles.contours}
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      stroke="var(--border-subtle)"
      strokeWidth="1"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M-40 620C220 560 420 700 660 640 900 580 1120 690 1500 600" />
      <path d="M-40 560C240 500 430 640 680 580 940 518 1140 630 1500 540" />
      <path d="M-40 500C260 442 450 578 700 520 980 456 1160 568 1500 480" />
      <path d="M-40 440C280 384 470 516 720 460 1010 396 1180 506 1500 420" />
      <path
        d="M-40 380C300 326 490 454 740 400 1040 336 1200 444 1500 360"
        stroke="var(--border-subtle-02)"
      />
      <path d="M-40 320C320 268 510 392 760 340 1070 276 1220 382 1500 300" />
      <path d="M-40 260C340 210 530 330 780 280 1100 216 1240 320 1500 240" />
      <path d="M-40 200C360 152 550 268 800 220 1130 156 1260 258 1500 180" />
    </svg>
  )
}

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
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.wash} />
        <ContourMotif />
      </div>

      <Container>
        <div className={styles.content}>
          <Eyebrow>Seoul, read as terrain</Eyebrow>

          <h1 className={styles.headline}>
            Urban <span className={styles.accent}>Flow</span>
          </h1>

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
