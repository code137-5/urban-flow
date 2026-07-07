import { TopNav } from './ui/TopNav'
import { Footer } from './ui/Footer'
import { Hero } from './sections/Hero'
import { About } from './sections/About'
import { Container, Section, Eyebrow } from './ui/layout'

/** Placeholder for the interactive comparison dashboard (built in P5). */
function DashboardPlaceholder() {
  return (
    <Section id="dashboard" divided>
      <Container>
        <Eyebrow>대시보드</Eyebrow>
        <h2 style={{ font: 'var(--type-display-md)', maxWidth: '18ch' }}>
          데이터별 등고선과 파티클을 나란히 비교
        </h2>
        <p
          style={{
            font: 'var(--type-body-lg)',
            color: 'var(--text-secondary)',
            marginTop: 'var(--space-md)',
            maxWidth: '60ch',
          }}
        >
          하나의 패널로 시작해 데이터셋을 추가하며 2개, 3개로 확장하는 인터랙티브
          비교 대시보드가 이 자리에 들어갑니다. (준비 중)
        </p>
      </Container>
    </Section>
  )
}

/**
 * Urban Flow landing composition.
 * Structure: TopNav → Hero → About → Dashboard → Footer.
 */
export default function App() {
  return (
    <>
      <TopNav />
      <main id="top">
        <Hero />
        <About />
        <DashboardPlaceholder />
      </main>
      <Footer />
    </>
  )
}
