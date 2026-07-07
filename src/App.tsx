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
        <Eyebrow>Dashboard</Eyebrow>
        <h2 style={{ font: 'var(--type-display-md)', maxWidth: '18ch' }}>
          Compare contours and particles side by side
        </h2>
        <p
          style={{
            font: 'var(--type-body-lg)',
            color: 'var(--text-secondary)',
            marginTop: 'var(--space-md)',
            maxWidth: '60ch',
          }}
        >
          An interactive comparison dashboard that starts with a single panel and
          grows to two or three as you add datasets will live here. (Coming soon)
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
