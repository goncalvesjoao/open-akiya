// Node child-process harness for the worker API. No production fault hooks or
// database inspection: interruption gates sit at synthetic adapter boundaries.
import { existsSync } from 'node:fs'
import { ImportRuntime } from '../runtime'
import { syntheticAdapter } from '../adapter'
import { testClock } from '../test-clock'
import { initialArea } from '../../shared/geography'
import type { Operation } from '../../shared/desktop'

const [path, mode, epoch] = process.argv.slice(2)
const clock = testClock(Number(epoch))
let clockReads = 0
let clockArmed = false
const base = syntheticAdapter(0)
let release: (() => void) | undefined
let requestId: string | undefined
let jobId: string | undefined
const query = { area: initialArea, showUnavailable: true }
function snapshot() {
  return {
    request: requestId ? runtime.inspectRequest(requestId) : null,
    job: jobId ? runtime.inspect(jobId) : null,
    results: runtime.results(query),
  }
}
async function gate(boundary: string) {
  if (mode !== boundary) return
  process.send?.({ event: 'boundary', boundary, ...snapshot() })
  await new Promise<void>((resolve) => {
    release = resolve
  })
  process.send?.({ event: 'continued' })
}
const starts: number[] = []
const runtime = new ImportRuntime(path, 0, {
  ...clock,
  now: () => {
    // Freeze the external clock inside the third request-time read: ownership
    // was read, but the initial attempt has not yet been accounted for.
    if (mode === 'account-race' && clockArmed && ++clockReads === 3) {
      process.send?.({ event: 'clock-check' })
      const timeout = Date.now() + 10000
      while (!existsSync(`${path}.release-clock`)) {
        if (Date.now() >= timeout) throw new Error('Clock gate timed out')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    return clock.now()
  },
  ...(mode.startsWith('budget') ? { discoveryLimit: 3 } : {}),
  leaseMs: mode === 'retry' || mode === 'retry-recovery' ? 1000 : 30000,
  wait: async (milliseconds, signal) => {
    await gate('retry')
    signal.throwIfAborted()
    clock.advance(milliseconds)
  },
  transport: async () => {
    starts.push(clock.now())
    await gate('budget')
    return mode === 'retry'
      ? { status: 429, headers: { 'retry-after': '5' } }
      : { status: mode === 'failed' ? 403 : 200 }
  },
  adapters: [
    {
      ...base,
      async discover(input, context) {
        clockArmed = mode === 'account-race'
        if (mode === 'unacknowledged') await new Promise<void>(() => {})
        const page = await base.discover(input, context)
        return {
          ...page,
          candidates: [
            page.candidates[0],
            {
              ...page.candidates[0],
              externalId: 'second',
              url: 'https://example.invalid/offers/second',
            },
          ],
        }
      },
      async fetchDetail(candidate, context) {
        const evidence = await base.fetchDetail(candidate, context)
        if (candidate.externalId === 'second') await gate('after-commit')
        else await gate('before-commit')
        await gate('cancelled')
        return evidence
      },
    },
    {
      ...base,
      capabilities: { ...base.capabilities, sourceId: 'tail' },
      async discover() {
        await gate('preterminal')
        if (mode === 'partial' || mode === 'failed')
          throw new Error('Synthetic tail parser failure')
        return {
          candidates: [],
          nextCursor: null,
          exhausted: true,
          limitation: null,
        }
      },
    },
  ],
})
process.on(
  'message',
  async (message: {
    id: number
    operation: Operation | 'release' | 'snapshot'
    input?: unknown
  }) => {
    try {
      let result: unknown
      if (message.operation === 'release') {
        release?.()
        result = null
      } else if (message.operation === 'snapshot')
        result = { ...snapshot(), starts }
      else {
        result = await runtime.dispatch(message.operation, message.input)
        if (message.operation === 'createImportRequest') {
          const request = result as { id: string; jobIds: string[] }
          requestId = request.id
          jobId = request.jobIds[0]
          await gate('unacknowledged')
        }
        if (message.operation === 'inspectImportRequest')
          requestId = String(message.input)
        if (message.operation === 'inspectImport') jobId = String(message.input)
      }
      process.send?.({ id: message.id, result })
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) })
    }
  },
)
process.send?.({ event: 'ready' })
