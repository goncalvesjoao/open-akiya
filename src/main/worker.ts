import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import {
  fixtures,
  uncertainFixtures,
  municipalityFixtures,
  unknownFixtures,
} from './fixtures'
import { safeError } from './errors'
import type { WorkerRequest } from '../shared/desktop'

const runtime = new ImportRuntime(process.argv[2], 300, {
  adapters: [
    syntheticAdapter(300, [
      fixtures[0],
      ...uncertainFixtures,
      ...municipalityFixtures,
      ...unknownFixtures,
    ]),
  ],
})
process.parentPort.on('message', async ({ data }: { data: WorkerRequest }) => {
  try {
    const result = await runtime.dispatch(data.operation, data.input)
    process.parentPort.postMessage({ id: data.id, result })
  } catch (error) {
    process.parentPort.postMessage({ id: data.id, error: safeError(error) })
  }
})
