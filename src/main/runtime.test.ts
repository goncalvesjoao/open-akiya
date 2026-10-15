// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter, type SourceAdapter } from './adapter'
import { initialArea } from '../shared/geography'

const directory = mkdtempSync(join(tmpdir(), 'akiya-runtime-'))
const runtimes: ImportRuntime[] = []
function open(name: string, delay = 1, adapters?: SourceAdapter[]) {
  const runtime = new ImportRuntime(
    join(directory, name),
    delay,
    adapters ? { adapters } : {},
  )
  runtimes.push(runtime)
  return runtime
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
const input = { area: initialArea, intent: 'import', idempotencyKey: 'one' }
const query = { area: initialArea, showUnavailable: true }

async function completed(runtime: ImportRuntime, id: string) {
  await expect.poll(() => runtime.inspect(id).state).toBe('succeeded')
  return runtime.inspect(id)
}

test('persists one fixed known-inside offer with truthful stages, counts, and unchanged updates', async () => {
  const runtime = open('identities.sqlite', 40)
  const request = runtime.createRequest(input)
  const jobId = request.jobIds[0]
  expect(runtime.inspect(jobId)).toMatchObject({
    stage: 'queued',
    startedAt: null,
    counts: { discovered: 0, checked: 0, added: 0 },
  })
  await expect.poll(() => runtime.inspect(jobId).stage).toBe('fetching')
  expect(runtime.inspectRequest(request.id)).toMatchObject({ state: 'running' })
  const job = await completed(runtime, jobId)
  expect(job).toMatchObject({
    counts: {
      discovered: 1,
      checked: 1,
      added: 1,
      updated: 0,
      unchanged: 0,
      rejected: 0,
    },
    budget: { discoveryUsed: 1, detailUsed: 1 },
    stage: 'finished',
    sources: [{ sourceId: 'fixture', state: 'succeeded' }],
  })
  expect(Date.parse(job.startedAt!)).toBeGreaterThanOrEqual(
    Date.parse(job.createdAt),
  )
  expect(Date.parse(job.finishedAt!)).toBeGreaterThanOrEqual(
    Date.parse(job.startedAt!),
  )
  expect(runtime.inspectRequest(request.id)).toMatchObject({
    state: 'succeeded',
    finishedAt: job.finishedAt,
  })
  const saved = runtime.results(query).listings
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({
    titleJa: 'サンプル売却情報',
    salePriceJpy: 0,
    rentMonthlyJpy: null,
    location: { kind: 'verified', point: { latitude: 35, longitude: 135 } },
  })
  expect(saved[0]).not.toHaveProperty('contentHash')
  expect(saved[0]).not.toHaveProperty('provenance')
  const second = runtime.createRequest({ ...input, idempotencyKey: 'two' })
  expect(second.jobIds[0]).not.toBe(jobId)
  expect(await completed(runtime, second.jobIds[0])).toMatchObject({
    counts: { added: 0, updated: 0, unchanged: 1 },
  })
  expect(runtime.results(query).listings[0].id).toBe(saved[0].id)
})

test('two worker runtimes atomically reuse a request key and only one executes any job', async () => {
  let active = 0
  let maximum = 0
  let discoveries = 0
  const base = syntheticAdapter(50)
  const adapter: SourceAdapter = {
    ...base,
    async discover(input, context) {
      active++
      maximum = Math.max(maximum, active)
      discoveries++
      try {
        await new Promise((resolve) => setTimeout(resolve, 80))
        return await base.discover(input, context)
      } finally {
        active--
      }
    },
  }
  const first = open('workers.sqlite', 1, [adapter])
  const second = open('workers.sqlite', 1, [adapter])
  const requests = await Promise.all([
    Promise.resolve().then(() => first.createRequest(input)),
    Promise.resolve().then(() => second.createRequest(input)),
  ])
  expect(requests[0]).toEqual(requests[1])
  const other = second.createRequest({ ...input, idempotencyKey: 'other' })
  expect(other.jobIds).not.toEqual(requests[0].jobIds)
  await expect.poll(() => discoveries).toBe(1)
  expect(second.inspect(other.jobIds[0]).state).toBe('queued')
  // Opening another worker while execution is live must not reset the running job.
  const third = open('workers.sqlite', 1, [adapter])
  expect(third.inspect(requests[0].jobIds[0]).state).toBe('running')
  await completed(first, requests[0].jobIds[0])
  await completed(second, other.jobIds[0])
  expect(discoveries).toBe(2)
  expect(maximum).toBe(1)
  expect(first.results(query).listings).toHaveLength(1)
})

test('result queries never collect and outside areas do not move the fixed offer', async () => {
  let calls = 0
  const base = syntheticAdapter(1)
  const adapter: SourceAdapter = {
    ...base,
    async discover(input, context) {
      calls++
      return base.discover(input, context)
    },
  }
  const runtime = open('reads.sqlite', 1, [adapter])
  expect(runtime.results(query).listings).toEqual([])
  expect(calls).toBe(0)
  const request = runtime.createRequest({
    ...input,
    area: { center: { latitude: 36, longitude: 136 }, radiusKm: 5 },
  })
  expect(await completed(runtime, request.jobIds[0])).toMatchObject({
    counts: { discovered: 0, checked: 0, added: 0 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  runtime.results(query)
  runtime.results(query)
  expect(calls).toBe(1)
  expect(runtime.results(query).listings).toEqual([])
})

test('rejects invalid area shapes and disabled sources before adapter calls', () => {
  const runtime = open('invalid.sqlite')
  for (const area of [
    { ...initialArea, radiusKm: 0 },
    { ...initialArea, radiusKm: 10.01 },
    { ...initialArea, radiusKm: '5' },
    { ...initialArea, radiusKm: null },
    { ...initialArea, center: { latitude: Infinity, longitude: 135 } },
    { ...initialArea, center: { latitude: 35 } },
    { ...initialArea, extra: true },
  ]) {
    expect(() => runtime.createRequest({ ...input, area })).toThrow()
  }
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
  expect(() =>
    runtime.createRequest({ ...input, intent: 'manual_refresh' }),
  ).toThrow()
  const disabled = open('disabled.sqlite', 1, [])
  expect(() => disabled.createRequest(input)).toThrow(
    expect.objectContaining({ status: 409, code: 'NO_ENABLED_SOURCES' }),
  )
  expect(() => disabled.inspect('missing')).toThrow(
    expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
  )
})

test('restarts after a committed offer and resumes saved progress without duplicate additions', async () => {
  let secondDetail = false
  const base = syntheticAdapter(10)
  const adapter: SourceAdapter = {
    ...base,
    async discover(input, context) {
      const page = await base.discover(input, context)
      return {
        ...page,
        candidates: [
          ...page.candidates,
          {
            ...page.candidates[0],
            externalId: 'sale-2',
            url: 'https://example.invalid/offers/sale-2',
          },
        ],
      }
    },
    async fetchDetail(candidate, context) {
      if (candidate.externalId === 'sale-2') {
        secondDetail = true
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            })
        })
        context.signal.throwIfAborted()
      }
      return base.fetchDetail(candidate, context)
    },
  }
  const runtime = open('recovery.sqlite', 1, [adapter])
  const request = runtime.createRequest(input)
  await expect.poll(() => secondDetail).toBe(true)
  expect(runtime.inspect(request.jobIds[0]).counts).toMatchObject({
    added: 1,
    checked: 1,
  })
  const firstSaved = runtime.results(query).listings[0]
  await runtime.close()
  const reopened = open('recovery.sqlite', 1, [
    { ...adapter, fetchDetail: base.fetchDetail },
  ])
  expect(await completed(reopened, request.jobIds[0])).toMatchObject({
    counts: { discovered: 2, checked: 2, added: 2, unchanged: 0 },
  })
  expect(reopened.createRequest(input).id).toBe(request.id)
  expect(reopened.results(query).listings).toHaveLength(2)
  expect(
    reopened
      .results(query)
      .listings.find((listing) => listing.id === firstSaved.id)?.firstSeenAt,
  ).toBe(firstSaved.firstSeenAt)
})

test('queued and running cancellation retains saved results and never restarts cancelled jobs', async () => {
  const runtime = open('cancel.sqlite', 100)
  const request = runtime.createRequest(input)
  const queued = runtime.createRequest({ ...input, idempotencyKey: 'queued' })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('fetching')
  expect(runtime.cancel(queued.jobIds[0]).state).toBe('cancelled')
  const cancelling = runtime.cancel(request.jobIds[0])
  expect(cancelling).toMatchObject({
    state: 'running',
    cancelRequestedAt: expect.any(String),
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).state)
    .toBe('cancelled')
  const stopped = runtime.inspect(request.jobIds[0])
  expect(runtime.cancel(stopped.id)).toEqual(stopped)
  await runtime.close()
  const reopened = open('cancel.sqlite')
  expect(reopened.inspect(stopped.id)).toEqual(stopped)
  expect(reopened.inspectRequest(request.id)).toMatchObject({
    state: 'cancelled',
    finishedAt: stopped.finishedAt,
  })
  expect(reopened.list({ state: 'active' }).jobs).toEqual([])
})

test('repeated discovery identities consume transport budget without duplicating offer counts', async () => {
  const base = syntheticAdapter(1)
  const adapter: SourceAdapter = {
    ...base,
    async discover(input, context) {
      const page = await base.discover(input, context)
      return { ...page, candidates: [...page.candidates, ...page.candidates] }
    },
  }
  const runtime = open('duplicates.sqlite', 1, [adapter])
  const request = runtime.createRequest(input)
  expect(await completed(runtime, request.jobIds[0])).toMatchObject({
    counts: { discovered: 1, checked: 1, added: 1, unchanged: 0 },
    budget: { detailUsed: 1 },
  })
})

test('adapter evidence and unapproved fields never enter saved listing projections', async () => {
  const base = syntheticAdapter(1)
  const adapter: SourceAdapter = {
    ...base,
    normalize(evidence) {
      const result = base.normalize(evidence)
      if (result.kind === 'accepted') {
        Object.assign(result.observation.identity, { secret: 'PRIVATE' })
        Object.assign(result.observation.fields.location ?? {}, {
          secret: 'PRIVATE',
        })
        Object.assign(result.observation.fields, {
          rawEvidence: 'PRIVATE',
          token: 'PRIVATE',
          editorialStatus: 'published',
        })
      }
      return result
    },
  }
  const runtime = open('projection.sqlite', 1, [adapter])
  const request = runtime.createRequest(input)
  await completed(runtime, request.jobIds[0])
  const listing = runtime.results(query).listings[0]
  expect(listing).not.toHaveProperty('rawEvidence')
  expect(listing).not.toHaveProperty('token')
  expect(listing).not.toHaveProperty('editorialStatus')
  expect(listing.sourceRefs[0]).not.toHaveProperty('secret')
  expect(listing.location).not.toHaveProperty('secret')
})

test.each(['floorAreaM2', 'landAreaM2'] as const)(
  'rejects zero %s without saving the observation or listing',
  async (field) => {
    const base = syntheticAdapter(1)
    let area = 0
    const adapter: SourceAdapter = {
      ...base,
      normalize(evidence) {
        const result = base.normalize(evidence)
        if (result.kind === 'accepted') result.observation.fields[field] = area
        return result
      },
    }
    const runtime = open(`zero-${field}.sqlite`, 1, [adapter])
    const rejected = runtime.createRequest(input)
    await expect
      .poll(() => runtime.inspect(rejected.jobIds[0]).state)
      .toBe('partial')
    expect(runtime.inspect(rejected.jobIds[0])).toMatchObject({
      counts: { checked: 1, rejected: 1, added: 0, updated: 0, unchanged: 0 },
      sources: [{ error: { code: 'INVALID_REQUEST' } }],
    })
    expect(runtime.results(query).listings).toEqual([])
    await runtime.close()
    // Reuse the same content hash: an accidentally persisted observation would
    // misclassify this first valid import as unchanged rather than newly added.
    area = 25.5
    const reopened = open(`zero-${field}.sqlite`, 1, [adapter])
    const accepted = reopened.createRequest({
      ...input,
      idempotencyKey: 'valid',
    })
    expect(await completed(reopened, accepted.jobIds[0])).toMatchObject({
      counts: { added: 1, updated: 0, unchanged: 0 },
    })
    expect(reopened.results(query).listings[0][field]).toBe(25.5)
  },
)

test('idle workers avoid write transactions and retained terminal payloads, but wake for local and external requests', async () => {
  vi.useFakeTimers()
  const path = join(directory, 'idle.sqlite')
  const runtime = open('idle.sqlite')
  const database = new DatabaseSync(path)
  // Retained terminal data is irrelevant to active listing and queue execution.
  const insert = database.prepare(
    'INSERT INTO import_jobs_v2 VALUES (?,?,?,?,?)',
  )
  for (let index = 0; index < 1000; index++)
    insert.run(`history-${index}`, 'succeeded', 'not active JSON', '{}', '{}')
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
  try {
    await vi.advanceTimersByTimeAsync(10000)
    expect(
      exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE'),
    ).toHaveLength(0)
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(12)
    expect(runtime.list({ state: 'active' }).jobs).toEqual([])
    const local = runtime.createRequest(input)
    await vi.advanceTimersByTimeAsync(100)
    expect(runtime.inspect(local.jobIds[0]).state).toBe('succeeded')

    // Another process can enqueue and quit while this runtime is idle.
    const writer = open('idle.sqlite')
    const external = writer.createRequest({
      ...input,
      idempotencyKey: 'external',
    })
    await writer.close()
    await vi.advanceTimersByTimeAsync(1100)
    expect(runtime.inspect(external.jobIds[0]).state).toBe('succeeded')
  } finally {
    exec.mockRestore()
    prepare.mockRestore()
    database.close()
    await runtime.close()
    vi.useRealTimers()
  }
})

test('an idle worker waits for a foreign lease to expire before recovering saved work', async () => {
  vi.useFakeTimers()
  const writer = open('expired-lease.sqlite')
  const request = writer.createRequest(input)
  await writer.close()
  const database = new DatabaseSync(join(directory, 'expired-lease.sqlite'))
  database
    .prepare('INSERT INTO executor_v2 VALUES (1,?,?)')
    .run('other-process', Date.now() + 500)
  database.close()
  const runtime = open('expired-lease.sqlite')
  try {
    await vi.advanceTimersByTimeAsync(400)
    expect(runtime.inspect(request.jobIds[0]).state).toBe('queued')
    await vi.advanceTimersByTimeAsync(700)
    expect(runtime.inspect(request.jobIds[0]).state).toBe('succeeded')
    expect(runtime.results(query).listings).toHaveLength(1)
  } finally {
    await runtime.close()
    vi.useRealTimers()
  }
})

test('rejects new verified observations with blank verification evidence', async () => {
  const base = syntheticAdapter(0)
  const adapter: SourceAdapter = {
    ...base,
    normalize(evidence) {
      const result = base.normalize(evidence)
      if (
        result.kind === 'accepted' &&
        result.observation.fields.location?.kind === 'verified'
      ) {
        result.observation.fields.location.evidence = '   '
      }
      return result
    },
  }
  const runtime = open('empty-location-evidence.sqlite', 0, [adapter])
  const request = runtime.createRequest(input)
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).state)
    .toBe('failed')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    counts: { added: 0, checked: 0 },
    error: { code: 'INVALID_REQUEST' },
  })
  expect(runtime.results(query).listings).toEqual([])
})
