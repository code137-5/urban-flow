import { SEOUL_BOUNDS } from '../../src/data/bounds.ts'
import { clipToSeoul } from './clip.ts'
import { aggregateToGrid, padBounds } from './grid.ts'
import type { DatasetJob } from './job.ts'
import { writeDataset } from './io.ts'
import { demJob } from './datasets/dem.ts'
import { temperatureJob } from './datasets/temperature.ts'
import { noiseJob } from './datasets/noise.ts'
import { humidityJob } from './datasets/humidity.ts'
import { populationJob } from './datasets/population.ts'
import { companiesJob } from './datasets/companies.ts'
import { employeesJob } from './datasets/employees.ts'

// Registry of preprocessing jobs. Add a dataset by writing an adapter under
// datasets/ and appending it here (mirrors src/data/sources/index.ts).
//
// Parked, not deleted: datasets/{saenghwalIngu,buildingDensity,
// residentialDensity,commercialDensity}.ts read data/raw/<id>.csv, which only
// ever existed as generated samples — a no-arg run died on the missing files.
// Drop the real CSVs into data/raw/ and re-add the import + the job here.
const JOBS: DatasetJob[] = [
  demJob,
  temperatureJob,
  noiseJob,
  humidityJob,
  populationJob,
  companiesJob,
  employeesJob,
]

/**
 * raw → grid → Seoul clip → public/data/<id>.json, for the selected jobs
 * (all of them when no ids are given).
 *
 *   npm run preprocess                 # every dataset
 *   npm run preprocess dem population  # a subset
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
    // One bounds for both steps: aggregateToGrid drops whatever falls outside it,
    // so a job that rasterizes onto the grid itself must see the same rectangle.
    const bounds = job.padMeters ? padBounds(SEOUL_BOUNDS, job.padMeters) : SEOUL_BOUNDS
    const cells = job.toCells(bounds)
    const gridded = aggregateToGrid(cells, {
      bounds,
      cellMeters: job.cellMeters,
      aggregation: job.aggregation,
    })
    writeDataset(job.id, job.clip === false ? gridded : clipToSeoul(gridded))
  }
  console.log('Done.')
}

run(process.argv.slice(2))
