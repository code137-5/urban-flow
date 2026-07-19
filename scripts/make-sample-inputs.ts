import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SEOUL_BOUNDS } from '../src/data/bounds.ts'

/**
 * Generate small SYNTHETIC raw inputs for the six new datasets into data/raw/,
 * so the preprocessing pipeline can run end-to-end before any real Seoul open
 * data exists. These are not real figures — just plausible spatial structure
 * (mountains for DEM, CBD/residential hotspots for the density/population sets)
 * so each dataset renders as visibly distinct contour terrain.
 *
 * Deterministic: a seeded mulberry32 PRNG (bare Math.random is banned in this
 * repo — it would make the terrain flicker across reloads). data/raw/ is
 * gitignored and regenerable; when real data arrives, drop it in and delete this.
 */

const RAW_DIR = fileURLToPath(new URL('../data/raw/', import.meta.url))
const M_PER_DEG_LAT = 111320

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Core {
  lng: number
  lat: number
  sigmaM: number
  amp: number
}

const [minLng, minLat, maxLng, maxLat] = SEOUL_BOUNDS
const centerLat = (minLat + maxLat) / 2
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180)

/** Sum of Gaussian bumps (distance in meters) + a flat base. */
function field(lng: number, lat: number, cores: Core[], base = 0): number {
  let v = base
  for (const c of cores) {
    const dx = (lng - c.lng) * M_PER_DEG_LNG
    const dy = (lat - c.lat) * M_PER_DEG_LAT
    v += c.amp * Math.exp(-(dx * dx + dy * dy) / (2 * c.sigmaM * c.sigmaM))
  }
  return v
}

// Approximate Seoul landmarks reused across datasets.
const GANGNAM = { lng: 127.028, lat: 37.498 }
const JUNGGU = { lng: 126.98, lat: 37.566 }
const YEOUIDO = { lng: 126.924, lat: 37.526 }
const JAMSIL = { lng: 127.1, lat: 37.513 }
const HONGDAE = { lng: 126.923, lat: 37.556 }
const BUKHANSAN = { lng: 126.99, lat: 37.66 }
const GWANAKSAN = { lng: 126.96, lat: 37.445 }
const NOWON = { lng: 127.06, lat: 37.655 }
const GANGSEO = { lng: 126.84, lat: 37.56 }
const SONGPA = { lng: 127.12, lat: 37.5 }

const CBD_CORES: Core[] = [
  { ...GANGNAM, sigmaM: 1800, amp: 1 },
  { ...JUNGGU, sigmaM: 1600, amp: 0.95 },
  { ...YEOUIDO, sigmaM: 1200, amp: 0.8 },
  { ...HONGDAE, sigmaM: 1100, amp: 0.55 },
  { ...JAMSIL, sigmaM: 1300, amp: 0.6 },
]

const RESIDENTIAL_CORES: Core[] = [
  { ...NOWON, sigmaM: 3000, amp: 1 },
  { ...GANGSEO, sigmaM: 3000, amp: 0.9 },
  { ...SONGPA, sigmaM: 2600, amp: 0.85 },
  { ...HONGDAE, sigmaM: 2200, amp: 0.6 },
  { lng: 127.05, lat: 37.55, sigmaM: 3000, amp: 0.7 }, // eastern belt
]

/** Scale a set of unit-amp cores to a peak amplitude. */
function scaled(cores: Core[], peak: number): Core[] {
  return cores.map((c) => ({ ...c, amp: c.amp * peak }))
}

interface SampleSpec {
  id: string
  seed: number
  base: number
  cores: Core[]
  /** Multiplicative noise magnitude (0 = smooth). */
  noise: number
  /** If set, also emit h0..h23 built from day (cores) + night (residential) mix. */
  hourly?: { nightPeak: number; nightBase: number }
}

const SPECS: SampleSpec[] = [
  // DEM — elevation: high mountains ring the city, low basin in the middle.
  {
    id: 'dem',
    seed: 0xde_11,
    base: 25,
    noise: 0.05,
    cores: [
      { ...BUKHANSAN, sigmaM: 4200, amp: 700 },
      { ...GWANAKSAN, sigmaM: 3600, amp: 560 },
      { lng: 127.02, lat: 37.65, sigmaM: 3000, amp: 300 }, // Suraksan-ish
      { lng: 126.83, lat: 37.58, sigmaM: 2600, amp: 180 }, // western hills
      { lng: 127.14, lat: 37.55, sigmaM: 2600, amp: 160 }, // eastern hills
    ],
  },
  // 생활인구 — daytime CBD-heavy, hourly.
  {
    id: 'saenghwal-ingu',
    seed: 0x5a_e7,
    base: 300,
    noise: 0.12,
    cores: scaled(CBD_CORES, 9000),
    hourly: { nightPeak: 5000, nightBase: 300 },
  },
  // 주민등록인구 — broad residential belts, static.
  {
    id: 'jumin-ingu',
    seed: 0x71_2c,
    base: 500,
    noise: 0.12,
    cores: scaled(RESIDENTIAL_CORES, 6000),
  },
  // 건축연면적 밀도 — built-up everywhere, peaks at cores.
  {
    id: 'building-density',
    seed: 0xb1_d6,
    base: 40,
    noise: 0.1,
    cores: scaled([...CBD_CORES, ...RESIDENTIAL_CORES], 420),
  },
  // 주거면적 밀도 — residential belts.
  {
    id: 'residential-density',
    seed: 0x9e_5d,
    base: 20,
    noise: 0.1,
    cores: scaled(RESIDENTIAL_CORES, 320),
  },
  // 상업면적 밀도 — sharp CBD/retail spikes.
  {
    id: 'commercial-density',
    seed: 0xc0_88,
    base: 5,
    noise: 0.1,
    cores: [
      { ...GANGNAM, sigmaM: 1200, amp: 450 },
      { ...JUNGGU, sigmaM: 1100, amp: 380 },
      { ...YEOUIDO, sigmaM: 900, amp: 300 },
      { ...HONGDAE, sigmaM: 800, amp: 240 },
    ],
  },
]

// Raw sampling grid ~300 m (finer than the 500 m preprocessing target so the
// aggregation step is meaningful).
const RAW_CELL_M = 300
const cols = Math.round(((maxLng - minLng) * M_PER_DEG_LNG) / RAW_CELL_M)
const rows = Math.round(((maxLat - minLat) * M_PER_DEG_LAT) / RAW_CELL_M)

const dayWeight = (h: number) => 0.15 + 0.85 * Math.exp(-((h - 13) ** 2) / (2 * 3.5 ** 2))
const nightWeight = (h: number) => {
  const d = Math.min(h, 24 - h) // distance from midnight
  return 0.25 + 0.75 * Math.exp(-(d * d) / (2 * 3.5 ** 2))
}

function generate(spec: SampleSpec): string {
  const rand = mulberry32(spec.seed)
  const header =
    'lng,lat,value' + (spec.hourly ? Array.from({ length: 24 }, (_, h) => `,h${h}`).join('') : '')
  const lines = [header]
  const nightCores = spec.hourly ? scaled(RESIDENTIAL_CORES, spec.hourly.nightPeak) : []

  for (let r = 0; r < rows; r++) {
    const lat = minLat + ((r + 0.5) / rows) * (maxLat - minLat)
    for (let c = 0; c < cols; c++) {
      const lng = minLng + ((c + 0.5) / cols) * (maxLng - minLng)
      const jitter = 1 + spec.noise * (rand() - 0.5) * 2
      const day = field(lng, lat, spec.cores, spec.base)
      const value = Math.max(0, day * jitter)
      let row = `${lng.toFixed(6)},${lat.toFixed(6)},${value.toFixed(2)}`
      if (spec.hourly) {
        const night = field(lng, lat, nightCores, spec.hourly.nightBase)
        for (let h = 0; h < 24; h++) {
          const hv = Math.max(0, (day * dayWeight(h) + night * nightWeight(h)) * jitter)
          row += `,${hv.toFixed(2)}`
        }
      }
      lines.push(row)
    }
  }
  return lines.join('\n') + '\n'
}

mkdirSync(RAW_DIR, { recursive: true })
console.log(`Generating synthetic raw inputs (${cols}×${rows} grid) → data/raw/`)
for (const spec of SPECS) {
  const csv = generate(spec)
  const path = `${RAW_DIR}${spec.id}.csv`
  writeFileSync(path, csv)
  const kb = (Buffer.byteLength(csv) / 1024).toFixed(0)
  console.log(`  ${spec.id}.csv (${kb} KB)`)
}
console.log('Done.')
