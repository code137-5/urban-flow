import { SEOUL_BOUNDS } from '../../src/data/bounds.ts'
import { clipToSeoul } from './clip.ts'
import { aggregateToGrid } from './grid.ts'
import type { DatasetJob } from './job.ts'
import { writeDataset } from './io.ts'
import { demJob } from './datasets/dem.ts'
import { saenghwalInguJob } from './datasets/saenghwalIngu.ts'
import { juminInguJob } from './datasets/juminIngu.ts'
import { buildingDensityJob } from './datasets/buildingDensity.ts'
import { residentialDensityJob } from './datasets/residentialDensity.ts'
import { commercialDensityJob } from './datasets/commercialDensity.ts'

// Registry of preprocessing jobs. Add a dataset by writing an adapter under
// datasets/ and appending it here (mirrors src/data/sources/index.ts).
const JOBS: DatasetJob[] = [
  demJob,
  saenghwalInguJob,
  juminInguJob,
  buildingDensityJob,
  residentialDensityJob,
  commercialDensityJob,
]

/**
 * raw → grid → Seoul clip → public/data/<id>.json, for the selected jobs
 * (all of them when no ids are given).
 *
 *   npm run preprocess                 # every dataset
 *   npm run preprocess dem jumin-ingu  # a subset
 */
function run(ids: string[]): void {
  const unknown = ids.filter((id) => !JOBS.some((j) => j.id === id))
  if (unknown.length > 0) {
    throw new Error(
      `unknown dataset(s): ${unknown.join(', ')}. known: ${JOBS.map((j) => j.id).join(', ')}`,
    )
  }
  const selected = ids.length > 0 ? JOBS.filter((j) => ids.includes(j.id)) : JOBS

  console.log(`Preprocessing ${selected.length} dataset(s) → public/data/`)
  for (const job of selected) {
    const cells = job.toCells()
    const gridded = aggregateToGrid(cells, {
      bounds: SEOUL_BOUNDS,
      cellMeters: job.cellMeters,
      aggregation: job.aggregation,
    })
    writeDataset(job.id, clipToSeoul(gridded))
  }
  console.log('Done.')
}

run(process.argv.slice(2))
