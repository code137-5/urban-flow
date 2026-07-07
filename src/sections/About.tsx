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
    title: '데이터 · 가중 지오포인트',
    body: '출처가 다른 서울 데이터를 위치와 가중치를 가진 지오포인트로 통일합니다. 데이터 층은 원본 형식을 가리지 않습니다.',
  },
  {
    no: '02',
    title: '등고선 지형 · KDE 하이트맵',
    body: 'KDE로 밀도를 추정해 하이트맵을 만들고, 같은 밀도를 잇는 등고선으로 도시를 지형처럼 그립니다.',
  },
  {
    no: '03',
    title: 'GPU 파티클 흐름',
    body: '지형의 경사를 따라 수천 개의 파티클이 GPU 위에서 실시간으로 흐르며 움직임의 방향과 세기를 드러냅니다.',
  },
]

const DATASETS: Dataset[] = [
  {
    title: '따릉이 (공공자전거)',
    body: '서울 곳곳 대여소의 자전거 이용을 집계해 생활 반경과 근거리 이동 수요를 지형으로 그려 냅니다.',
    unit: '단위 · 대여 건수',
  },
  {
    title: '생활이동 (인구 OD)',
    body: '지역과 지역 사이를 오가는 인구 흐름으로 도시의 출발지와 도착지 관계를 이어 봅니다.',
    unit: '단위 · 이동 인구',
  },
  {
    title: '지하철 승하차',
    body: '역별 승차와 하차 인원으로 대중교통 거점의 혼잡과 시간대별 리듬을 포착합니다.',
    unit: '단위 · 승하차 인원',
  },
]

/** Project explanation section — concept, pipeline, and the three datasets. */
export function About() {
  return (
    <Section id="about" divided>
      <Container>
        <div className={styles.intro}>
          <Eyebrow>프로젝트 소개</Eyebrow>
          <h2 className={styles.headline}>
            서울의 하루를 등고선 지형과 파티클 흐름으로 읽습니다
          </h2>
          <p className={styles.lead}>
            Urban Flow는 서울의 공공 데이터를 등고선 지형으로 표현하고, 그 위를
            흐르는 GPU 파티클로 도시의 움직임을 시각화합니다. 시간대별로 밀도가
            어떻게 변하는지, 서로 다른 데이터셋이 어디에서 겹치고 갈라지는지 한
            화면에서 비교할 수 있습니다.
          </p>
        </div>

        <div className={styles.pipeline}>
          <h3 className={styles.subhead}>어떻게 동작하나</h3>
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
          <h3 className={styles.subhead}>세 가지 데이터셋</h3>
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
