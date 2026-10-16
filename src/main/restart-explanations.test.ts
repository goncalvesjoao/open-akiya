// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { LocalApiError } from './errors'
import { initialArea } from '../shared/geography'
import { testClock } from './test-clock'

const runtimes: ImportRuntime[] = []
const directories: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'restart-explanations-'))
  directories.push(directory)
  return join(directory, 'db.sqlite')
}

test('repeated source configuration restarts keep one reason and caveat in persisted queued inspection', async () => {
  const path = database()
  const clock = testClock(0)
  const base = syntheticAdapter(0)
  let runtime = new ImportRuntime(path, 0, clock)
  runtimes.push(runtime)
  const original = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'original',
  })
  runtime.cancel(original.jobIds[0])
  let fromJobId = original.jobIds[0]
  for (const version of ['v2', 'v3']) {
    await runtime.close()
    runtime = new ImportRuntime(path, 0, {
      ...clock,
      adapters: [
        {
          ...base,
          capabilities: { ...base.capabilities, adapterVersion: version },
        },
      ],
    })
    runtimes.push(runtime)
    const request = runtime.createRequest({
      intent: 'continue',
      fromJobId,
      idempotencyKey: version,
    })
    const queued = runtime.inspect(request.jobIds[0])
    expect(queued.reasons).toEqual(['SOURCE_CONFIGURATION_CHANGED'])
    expect(
      queued.coverage.caveats.filter(
        (caveat) =>
          caveat ===
          'Source configuration changed; discovery restarted with current semantics',
      ),
    ).toHaveLength(1)
    runtime.cancel(request.jobIds[0])
    fromJobId = request.jobIds[0]
  }
})

test.each(['CURSOR_EXPIRED', 'CURSOR_INVALID'])(
  'repeated %s keeps one persisted running and successful restart explanation',
  async (code) => {
    const path = database()
    const clock = testClock(0)
    const base = syntheticAdapter(0)
    let starts = 0
    let waiting = false
    let release!: () => void
    const adapter = {
      ...base,
      async discover(
        input: Parameters<typeof base.discover>[0],
        context: Parameters<typeof base.discover>[1],
      ) {
        if (input.cursor) {
          await context.request('discovery', 'https://example.invalid/rejected')
          throw new LocalApiError(409, code, 'Synthetic rejected cursor')
        }
        starts++
        if (starts === 3) {
          waiting = true
          await new Promise<void>((resolve) => {
            release = resolve
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            })
          })
          context.signal.throwIfAborted()
        }
        const page = await base.discover(input, context)
        return {
          ...page,
          nextCursor: starts === 3 ? null : 'saved',
          exhausted: starts === 3,
        }
      },
    }
    let runtime = new ImportRuntime(path, 0, {
      ...clock,
      discoveryLimit: 1,
      adapters: [adapter],
    })
    runtimes.push(runtime)
    const original = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'original',
    })
    await expect
      .poll(() => runtime.inspect(original.jobIds[0]).stage)
      .toBe('finished')
    await runtime.close()
    const options = { ...clock, discoveryLimit: 5, adapters: [adapter] }
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.jobIds[0],
      idempotencyKey: 'next',
    })
    await expect.poll(() => waiting).toBe(true)
    const caveat =
      'Saved cursor expired or invalid; discovery restarted within this job budget'
    const running = runtime.inspect(next.jobIds[0])
    expect(running.state).toBe('running')
    expect(running.reasons).toEqual([code])
    expect(
      running.coverage.caveats.filter((value) => value === caveat),
    ).toHaveLength(1)
    release()
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).stage)
      .toBe('finished')
    const completed = runtime.inspect(next.jobIds[0])
    expect(completed).toMatchObject({
      state: 'succeeded',
      reasons: [code],
      budget: { discoveryUsed: 4, detailUsed: 0 },
    })
    expect(
      completed.coverage.caveats.filter((value) => value === caveat),
    ).toHaveLength(1)
    await runtime.close()
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    expect(runtime.inspect(next.jobIds[0])).toEqual(completed)
  },
)
