import { TopNav } from './ui/TopNav'
import { Footer } from './ui/Footer'
import { DataNotice } from './ui/DataNotice'
import { Hero } from './sections/Hero'
import { About } from './sections/About'
import { Dashboard } from './sections/Dashboard'

/**
 * Urban Flow landing composition.
 * Structure: TopNav → Hero → About → Dashboard → Footer,
 * plus a once-per-session synthetic-data notice dialog.
 */
export default function App() {
  return (
    <>
      <TopNav />
      <main id="top">
        <Hero />
        <About />
        <Dashboard />
      </main>
      <Footer />
      <DataNotice />
    </>
  )
}
