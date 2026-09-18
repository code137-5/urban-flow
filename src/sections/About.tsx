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
    body: 'Particles replay real origin–destination trips across the terrain in real time on the GPU, revealing the direction and intensity of the city’s movement.',
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
  {
    title: 'Workers (종사자)',
    body: 'Seoul by day: 2024 workers counted at their workplace on the same SGIS 100 m grid, summed per 250 m cell — the daytime mirror of the population map, peaking in the office towers.',
    unit: 'Unit · workers',
  },
]

/**
 * The two particle flows. They carry the provenance and caveats the old load-time
 * notice dialog used to show — this section is now the only place they live.
 */
const FLOWS: Dataset[] = [
  {
    title: 'Bike trips (따릉이)',
    body: 'Ttareungi public-bike rentals between stations. Station pairs are sampled in proportion to their trip counts and drawn as straight lines at an illustrative speed; rides returned to the same station are left out.',
    unit: 'White particles · station to station',
  },
  {
    title: 'Living migration (생활이동)',
    body: 'Seoul living-migration movement between administrative dongs, sampled the same way. Endpoints are scattered around each dong’s centre, and movement inside a single dong is left out.',
    unit: 'Yellow particles · dong to dong',
  },
]

/** Project explanation section — concept, pipeline, the seven datasets and the two flows. */
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
          <h3 className={styles.subhead}>Seven datasets</h3>
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

        <div className={styles.datasets}>
          <h3 className={styles.subhead}>Two particle flows</h3>
          <div className={styles.cardGrid}>
            {FLOWS.map((flow) => (
              <article key={flow.title} className={styles.card}>
                <h4 className={styles.cardTitle}>{flow.title}</h4>
                <p className={styles.cardBody}>{flow.body}</p>
                <p className={styles.cardMeta}>{flow.unit}</p>
              </article>
            ))}
          </div>
        </div>
      </Container>
    </Section>
  )
}
