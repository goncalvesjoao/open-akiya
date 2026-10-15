// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { initialArea } from '../shared/geography'

const directory = mkdtempSync(join(tmpdir(), 'akiya-runtime-'))
const runtimes: ImportRuntime[] = []
function open(name: string, delay = 10) {
  const runtime = new ImportRuntime(join(directory, name), delay)
  runtimes.push(runtime)
  return runtime
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
const input = { area: initialArea, idempotencyKey: 'one' }
const query = { area: initialArea, showUnavailable: true }

test('persists idempotency and source identities across repeated completed imports', async () => {
  const runtime = open('identities.sqlite')
  const first = runtime.create(input)
  expect(runtime.create(input).id).toBe(first.id)
  expect(
    runtime.create({
      ...input,
      area: { radiusKm: 5, center: { longitude: 135, latitude: 35 } },
    }).id,
  ).toBe(first.id)
  const attached = runtime.create({ ...input, idempotencyKey: 'attached' })
  expect(attached.id).toBe(first.id)
  expect(() =>
    runtime.create({ ...input, area: { ...initialArea, radiusKm: 2 } }),
  ).toThrow('another area')
  await expect.poll(() => runtime.inspect(first.id).state).toBe('succeeded')
  expect(runtime.inspect(first.id).added).toBe(4)
  expect(runtime.results(query).listings).toHaveLength(4)
  const second = runtime.create({ ...input, idempotencyKey: 'two' })
  await expect.poll(() => runtime.inspect(second.id).state).toBe('succeeded')
  expect(runtime.inspect(second.id)).toMatchObject({ added: 0, updated: 4 })
  expect(runtime.create({ ...input, idempotencyKey: 'attached' }).id).toBe(
    first.id,
  )
  expect(runtime.results(query).listings).toHaveLength(4)
})

test('executes one job, cancels queued/running jobs and never resumes cancellation', async () => {
  const runtime = open('cancel.sqlite', 80)
  const first = runtime.create(input)
  const queued = runtime.create({
    area: { ...initialArea, radiusKm: 2 },
    idempotencyKey: 'two',
  })
  await expect.poll(() => runtime.inspect(first.id).state).toBe('running')
  expect(runtime.inspect(queued.id).state).toBe('queued')
  expect(runtime.cancel(queued.id).state).toBe('cancelled')
  await expect
    .poll(() => runtime.inspect(first.id).processed)
    .toBeGreaterThan(0)
  const stopped = runtime.cancel(first.id)
  expect(stopped.state).toBe('cancelled')
  expect(runtime.cancel(first.id)).toEqual(stopped)
  await runtime.close()
  runtimes.splice(runtimes.indexOf(runtime), 1)
  const reopened = open('cancel.sqlite')
  expect(reopened.inspect(first.id).state).toBe('cancelled')
  expect(reopened.inspect(queued.id).state).toBe('cancelled')
  expect(reopened.results(query).listings.length).toBe(stopped.processed)
})

test('recovers interrupted work after committed effects without duplicate additions', async () => {
  const runtime = open('recovery.sqlite', 80)
  const job = runtime.create(input)
  await expect.poll(() => runtime.inspect(job.id).processed).toBeGreaterThan(0)
  await runtime.close()
  runtimes.splice(runtimes.indexOf(runtime), 1)
  const reopened = open('recovery.sqlite')
  await expect.poll(() => reopened.inspect(job.id).state).toBe('succeeded')
  expect(reopened.create(input).id).toBe(job.id)
  expect(reopened.results(query).listings).toHaveLength(4)
  expect(reopened.inspect(job.id)).toMatchObject({
    added: 4,
    updated: 0,
    processed: 4,
  })
})

test('rejects invalid inputs before scheduling work', () => {
  const runtime = open('invalid.sqlite')
  expect(() =>
    runtime.create({ ...input, area: { ...initialArea, radiusKm: 0 } }),
  ).toThrow('Invalid selected area')
  expect(() => runtime.create({ ...input, idempotencyKey: '' })).toThrow(
    'Invalid identifier',
  )
  expect(runtime.list()).toEqual([])
  expect(runtime.results(query).listings).toEqual([])
})
