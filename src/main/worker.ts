import { ImportRuntime } from './runtime'
import type { WorkerRequest } from '../shared/desktop'

const runtime = new ImportRuntime(process.argv[2])
process.parentPort.on('message', async ({ data }: { data: WorkerRequest }) => {
  try {
    const result = await runtime.dispatch(data.operation, data.input)
    process.parentPort.postMessage({ id: data.id, result })
  } catch (error) {
    // Validation errors are intentionally safe; database errors stay private.
    const message =
      error instanceof Error &&
      /^(Invalid |Import not found|Idempotency key|Unknown operation)/.test(
        error.message,
      )
        ? error.message
        : 'Local worker operation failed. Saved data is retained.'
    process.parentPort.postMessage({ id: data.id, error: message })
  }
})
