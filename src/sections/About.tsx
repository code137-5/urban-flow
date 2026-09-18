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
    body: 'Kernel smoothing builds a heightmap from the data, and contour lines connecting equal values draw the city as if it were terrain.',
  },
  {
    no: '03',
    title: 'GPU particle flow',
    body: 'Thousands of particles flow across the terrain in real time on the GPU, revealing the direction and intensity of the city’s movement.',
  },
]

const DATASETS: Dataset[] = [
  {
    title: 'Elevation (DEM)',
    body: 'Seoul’s real terrain, rasterized from the city’s 20 m elevation contour lines — the ground every other layer is read against.',
    unit: 'Unit · meters',
  },
  {
    title: 'Temperature (기온)',
    body: 'Air temperature as 2023 yearly medians from the S-DoT city sensor network, interpolated between sensors into a continuous field.',
    unit: 'Unit · °C',
  },
  {
    title: 'Noise (소음)',
    body: 'Ambient noise as 2023 yearly medians from the same sensor network — the widest-ranging of the three, so loud and quiet districts separate clearly.',
    unit: 'Unit · dB',
  },
  {
    title: 'Humidity (습도)',
    body: 'Relative humidity as 2023 yearly medians from the same sensor network, tracing where the city’s air stays damp and where it runs dry.',
    unit: 'Unit · %RH',
  },
  {
    title: 'Population (인구)',
    body: 'Where Seoul actually lives: 2024 resident population from Statistics Korea’s SGIS 100 m grid, summed per 250 m cell — apartment belts rise as ridges, mountains and the river fall away.',
    unit: 'Unit · people',
  },
  {
    title: 'Businesses (사업체)',
    body: 'Where Seoul works: 2024 business establishments from the same SGIS 100 m grid, summed per 250 m cell — office cores and commercial corridors stand up as sharp ridges.',
    unit: 'Unit · establishments',
  },
]

/** Project explanation section — concept, pipeline, and the six datasets. */
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
            how each layer of the city rises and falls, and where different datasets
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
          <h3 className={styles.subhead}>Six datasets</h3>
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
