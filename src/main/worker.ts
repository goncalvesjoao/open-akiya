import { createLocationSearch } from './location-search'
import { ImportRuntime } from './runtime'
import { testClock } from './test-clock'
import { syntheticAdapter } from './adapter'
import {
  fixtures,
  uncertainFixtures,
  municipalityFixtures,
  unknownFixtures,
} from './fixtures'
import { safeError } from './errors'
import type { WorkerRequest } from '../shared/desktop'

// Synthetic E2E imports advance pacing without waiting on wall time.
const fastTest = process.env.OPEN_AKIYA_TEST_FAST === '1'
// Keep detail work observable in the real import journey while source pacing
// still uses the controlled clock; this switch is ignored outside test mode.
const delay =
  fastTest && process.env.OPEN_AKIYA_TEST_IMPORT_PROGRESS !== '1' ? 0 : 300
const runtime = new ImportRuntime(process.argv[2], delay, {
  ...(fastTest ? testClock() : {}),
  adapters: [
    syntheticAdapter(delay, [
      fixtures[0],
      ...uncertainFixtures,
      ...municipalityFixtures,
      ...unknownFixtures,
    ]),
  ],
})
const searchLocations = createLocationSearch(
  process.env.OPEN_AKIYA_LOCATION_SEARCH_URL,
)
process.parentPort.on('message', async ({ data }: { data: WorkerRequest }) => {
  try {
    const result =
      data.operation === 'searchLocations'
        ? await searchLocations(data.input)
        : await runtime.dispatch(data.operation, data.input)
    process.parentPort.postMessage({ id: data.id, result })
  } catch (error) {
    process.parentPort.postMessage({ id: data.id, error: safeError(error) })
  }
})
