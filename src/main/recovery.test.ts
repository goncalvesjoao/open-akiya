// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { initialArea } from '../shared/geography'
import { testClock } from './test-clock'

const input = {
  area: initialArea,
  intent: 'import',
  idempotencyKey: 'recovery',
}

test('a transport failure after lease takeover cannot schedule a stale retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-fencing-'))
  const path = join(directory, 'db.sqlite')
  let rejectTransport!: (error: Error) => void
  let started = false
  let staleWaits = 0
  const first = new ImportRuntime(path, 0, {
    now: () => 0,
    leaseMs: 100000,
    transport: () => {
      started = true
      return new Promise((_resolve, reject) => {
        rejectTransport = reject
      })
    },
    wait: async () => {
      staleWaits++
    },
  })
  let release!: () => void
  let reclaimed = false
  const base = syntheticAdapter(0)
  let second: ImportRuntime | undefined
  try {
    const request = first.createRequest(input)
    await expect.poll(() => started).toBe(true)
    second = new ImportRuntime(path, 0, {
      ...testClock(200000),
      adapters: [
        {
          ...base,
          async discover(input, context) {
            reclaimed = true
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return base.discover(input, context)
          },
        },
      ],
    })
    await expect.poll(() => reclaimed).toBe(true)
    rejectTransport(new Error('connection dropped after takeover'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(staleWaits).toBe(0)
    release()
    const recovered = second
    await expect
      .poll(() => recovered.inspect(request.jobIds[0]).state)
      .toBe('succeeded')
    expect(recovered.inspect(request.jobIds[0])).toMatchObject({
      counts: { discovered: 1, checked: 1, added: 1 },
      budget: { discoveryUsed: 2, detailUsed: 1 },
    })
  } finally {
    release?.()
    rejectTransport?.(new Error('shutdown'))
    await first.close()
    await second?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
