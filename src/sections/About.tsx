import { Container, Section, Eyebrow } from '../ui/layout'
import styles from './About.module.css'

interface Step {
  no: string
  title: string
  body: string
}

interface Dataset {
  title: string
  body: string
  unit: string
}

const STEPS: Step[] = [
  {
    no: '01',
    title: 'Data · weighted geopoints',
    body: 'Seoul data from different sources is unified into geopoints with a location and a weight. The data layer stays agnostic to the original format.',
  },
  {
    no: '02',
    title: 'Contour terrain · KDE heightmap',
    body: 'Kernel density estimation builds a heightmap, and contour lines connecting equal density draw the city as if it were terrain.',
  },
  {
    no: '03',
    title: 'GPU particle flow',
    body: 'Thousands of particles flow across the terrain in real time on the GPU, revealing the direction and intensity of the city’s movement.',
  },
]

const DATASETS: Dataset[] = [
  {
    title: 'Ttareungi (public bike)',
    body: 'Bike usage across Seoul’s rental stations, aggregated to map everyday range and short-distance travel demand as terrain.',
    unit: 'Unit · rentals',
  },
  {
    title: 'Living migration (population OD)',
    body: 'Population flowing between districts, tracing the city’s origin-and-destination relationships.',
    unit: 'Unit · people moved',
  },
  {
    title: 'Subway ridership',
    body: 'Boarding and alighting counts per station, capturing congestion at transit hubs and their rhythm across the day.',
    unit: 'Unit · riders',
  },
]

/** Project explanation section — concept, pipeline, and the three datasets. */
export function About() {
  return (
    <Section id="about" divided>
      <Container>
        <div className={styles.intro}>
          <Eyebrow>About the project</Eyebrow>
          <h2 className={styles.headline}>
            Reading Seoul’s day as contour terrain and particle flow
          </h2>
          <p className={styles.lead}>
            Urban Flow renders Seoul’s public data as contour-line terrain and
            visualizes the city’s movement with GPU particles flowing over it. See
            how density shifts across the hours, and where different datasets
            overlap or diverge — all compared on a single screen.
          </p>
        </div>

        <div className={styles.pipeline}>
          <h3 className={styles.subhead}>How it works</h3>
          <ol className={styles.steps}>
            {STEPS.map((step) => (
              <li key={step.no} className={styles.step}>
                <span className={styles.stepNo}>{step.no}</span>
                <h4 className={styles.stepTitle}>{step.title}</h4>
                <p className={styles.stepBody}>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>

        <div className={styles.datasets}>
          <h3 className={styles.subhead}>Three datasets</h3>
          <div className={styles.cardGrid}>
            {DATASETS.map((dataset) => (
              <article key={dataset.title} className={styles.card}>
                <h4 className={styles.cardTitle}>{dataset.title}</h4>
                <p className={styles.cardBody}>{dataset.body}</p>
                <p className={styles.cardMeta}>{dataset.unit}</p>
              </article>
            ))}
          </div>
        </div>
      </Container>
    </Section>
  )
}
