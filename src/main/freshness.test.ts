// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { fixtures } from './fixtures'
import { testClock } from './test-clock'
import { initialArea } from '../shared/geography'
import type { SelectedArea } from '../shared/listings'

const directory = mkdtempSync(join(tmpdir(), 'akiya-freshness-'))
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
let key = 0
function request(runtime: ImportRuntime, area: SelectedArea = initialArea) {
  return runtime.createRequest({
    area,
    intent: 'import',
    idempotencyKey: String(++key),
  })
}
async function done(runtime: ImportRuntime, id: string) {
  await expect
    .poll(() => runtime.inspect(id).state)
    .not.toMatch(/queued|running/)
  return runtime.inspect(id)
}

test('fresh covering success is reused durably with its original check times and requested results', async () => {
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const calls: string[] = []
  const options = {
    ...clock,
    transport: async (url: string) => {
      calls.push(url)
      return { status: 200 }
    },
  }
  const path = join(directory, 'cover.sqlite')
  let runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  const first = request(runtime)
  const job = await done(runtime, first.jobIds[0])
  expect(job.coverage).toMatchObject({
    status: 'complete',
    freshUntil: '2026-10-17T00:00:02.000Z',
  })
  await runtime.close()
  runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  clock.advance(1000)
  const area = { ...initialArea, radiusKm: 2 }
  const cached = request(runtime, area)
  expect(cached).toMatchObject({
    area,
    disposition: 'cached',
    state: 'succeeded',
    jobIds: first.jobIds,
  })
  expect(runtime.inspectRequest(cached.id)).toEqual(cached)
  expect(runtime.results({ area, showUnavailable: false })).toMatchObject({
    area,
    coverage: job.coverage,
  })
  expect(calls).toHaveLength(2)
  await runtime.dispatch('cancelImportRequest', cached.id)
  expect(runtime.inspect(first.jobIds[0])).toEqual(job)
})

test('overlap discovers again but reuses recent details without renewing their actual check or expiry', async () => {
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const calls: string[] = []
  const runtime = new ImportRuntime(join(directory, 'details.sqlite'), 0, {
    ...clock,
    transport: async (url) => {
      calls.push(url)
      return { status: 200 }
    },
  })
  runtimes.push(runtime)
  const first = await done(runtime, request(runtime).jobIds[0])
  const before = runtime.results({
    area: initialArea,
    showUnavailable: true,
  }).listings
  clock.advance(3600000)
  const overlapping = {
    ...initialArea,
    center: { ...initialArea.center, latitude: 35.01 },
  }
  const next = request(runtime, overlapping)
  expect(next.disposition).toBe('created')
  const job = await done(runtime, next.jobIds[0])
  expect(job).toMatchObject({
    state: 'succeeded',
    counts: { checked: 0 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(job.coverage.freshUntil).toBe(first.coverage.freshUntil)
  expect(
    runtime.results({ area: overlapping, showUnavailable: false }).listings,
  ).toEqual(before)
  expect(calls).toHaveLength(3)
  clock.advance(Date.parse(job.coverage.freshUntil!) - clock.now())
  const expired = request(runtime, overlapping)
  expect(expired.disposition).toBe('created')
  expect(await done(runtime, expired.jobIds[0])).toMatchObject({
    counts: { checked: 1 },
  })
})

test('contained requests attach to queued covering work without extra source requests', async () => {
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  let calls = 0
  const runtime = new ImportRuntime(join(directory, 'queue.sqlite'), 0, {
    ...clock,
    transport: async () => {
      calls++
      return { status: 200 }
    },
  })
  runtimes.push(runtime)
  const first = request(runtime)
  const queued = request(runtime, { ...initialArea, radiusKm: 2 })
  await done(runtime, first.jobIds[0])
  await expect
    .poll(() => runtime.inspectRequest(queued.id).state)
    .toBe('succeeded')
  expect(runtime.inspectRequest(queued.id)).toMatchObject({
    disposition: 'attached',
    jobIds: first.jobIds,
  })
  expect(calls).toBe(2)
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
})

test('incomplete discovery and unfinished details never certify cache and retain source caveats after restart', async () => {
  const base = syntheticAdapter(0)
  const adapter = {
    ...base,
    async discover(...args: Parameters<typeof base.discover>) {
      return {
        ...(await base.discover(...args)),
        limitation: 'Municipality source only exposes its first page',
      }
    },
  }
  const path = join(directory, 'limited.sqlite')
  const options = {
    ...testClock(Date.parse('2026-10-16T00:00:00Z')),
    adapters: [adapter],
  }
  let runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  expect(await done(runtime, request(runtime).jobIds[0])).toMatchObject({
    state: 'partial',
    coverage: { freshUntil: null },
  })
  await runtime.close()
  runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  expect(
    runtime.results({ area: initialArea, showUnavailable: false }).coverage,
  ).toMatchObject({
    status: 'partial',
    caveats: expect.arrayContaining([
      'Municipality source only exposes its first page',
    ]),
  })
  expect(request(runtime).disposition).toBe('created')
})

test.each([
  'adapterVersion',
  'queryVersion',
  'sources',
  'referenceVersion',
  'fixedFilters',
])(
  '%s changes invalidate successful area coverage and relevant detail semantics',
  async (field) => {
    const path = join(directory, `semantic-${field}.sqlite`)
    const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
    const base = syntheticAdapter(0)
    let runtime = new ImportRuntime(path, 0, { ...clock, adapters: [base] })
    runtimes.push(runtime)
    await done(runtime, request(runtime).jobIds[0])
    await runtime.close()
    const changed = {
      ...base,
      capabilities: {
        ...base.capabilities,
        ...(field === 'adapterVersion' ? { adapterVersion: 'v2' } : {}),
        ...(field === 'queryVersion' ? { queryVersion: 'v2' } : {}),
      },
    }
    runtime = new ImportRuntime(path, 0, {
      ...clock,
      adapters:
        field === 'sources'
          ? [
              base,
              syntheticAdapter(0, [
                {
                  ...fixtures[0],
                  sourceRefs: [
                    { ...fixtures[0].sourceRefs[0], sourceId: 'extra' },
                  ],
                },
              ]),
            ]
          : [changed],
      ...(field === 'referenceVersion'
        ? { referenceVersion: 'reference-v2' }
        : {}),
      ...(field === 'fixedFilters'
        ? { fixedFilters: { residential: false } }
        : {}),
    })
    runtimes.push(runtime)
    expect(
      runtime.results({ area: initialArea, showUnavailable: false }).coverage
        .status,
    ).toBe('unknown')
    const next = request(runtime)
    expect(next.disposition).toBe('created')
    const job = await done(runtime, next.jobIds[0])
    expect(job.state).toBe('succeeded')
    expect(job.counts.checked).toBe(1)
  },
)

test('failed expired refresh retains successful evidence and saved results without renewing either freshness', async () => {
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  let fail = false
  const runtime = new ImportRuntime(join(directory, 'failure.sqlite'), 0, {
    ...clock,
    transport: async () => ({ status: fail ? 403 : 200 }),
  })
  runtimes.push(runtime)
  const first = await done(runtime, request(runtime).jobIds[0])
  const before = runtime.results({ area: initialArea, showUnavailable: false })
  clock.advance(Date.parse(first.coverage.freshUntil!) - clock.now())
  fail = true
  const failed = await done(runtime, request(runtime).jobIds[0])
  expect(failed.state).toBe('failed')
  const results = runtime.results({ area: initialArea, showUnavailable: false })
  expect(results.listings).toEqual(before.listings)
  expect(results.coverage).toMatchObject({
    lastSuccessfulCheckAt: first.coverage.lastSuccessfulCheckAt,
    freshUntil: first.coverage.freshUntil,
  })
  expect(request(runtime).disposition).toBe('created')
})

test.each([
  { radiusKm: 5, center: initialArea.center, cached: true },
  { radiusKm: 5.0001, center: initialArea.center, cached: false },
  { radiusKm: 2, center: { latitude: 35.04, longitude: 135 }, cached: false },
])(
  'circle containment uses the inclusive boundary: %j',
  async ({ cached, ...area }) => {
    const runtime = new ImportRuntime(
      join(directory, `boundary-${++key}.sqlite`),
      0,
      testClock(0),
    )
    runtimes.push(runtime)
    await done(runtime, request(runtime).jobIds[0])
    expect(request(runtime, area).disposition).toBe(
      cached ? 'cached' : 'created',
    )
  },
)

test('complete empty traversal is reusable, while completed discovery with deferred details is not', async () => {
  const clock = testClock(0)
  const runtime = new ImportRuntime(join(directory, 'deferred.sqlite'), 0, {
    ...clock,
    detailLimit: 1,
    adapters: [syntheticAdapter(0, fixtures.slice(0, 2))],
  })
  runtimes.push(runtime)
  const partial = await done(runtime, request(runtime).jobIds[0])
  expect(partial).toMatchObject({
    state: 'partial',
    coverage: { freshUntil: null },
  })
  expect(request(runtime).disposition).toBe('created')
  const outside = { center: { latitude: 50, longitude: 100 }, radiusKm: 1 }
  const empty = await done(runtime, request(runtime, outside).jobIds[0])
  expect(empty).toMatchObject({
    state: 'succeeded',
    counts: { discovered: 0, checked: 0 },
  })
  expect(request(runtime, outside)).toMatchObject({
    disposition: 'cached',
    jobIds: [empty.id],
  })
})

test('a shorter detail freshness policy applies to persisted covering work after restart', async () => {
  const path = join(directory, 'shorter-detail-policy.sqlite')
  const clock = testClock(0)
  let runtime = new ImportRuntime(path, 0, clock)
  runtimes.push(runtime)
  await done(runtime, request(runtime).jobIds[0])
  await runtime.close()
  clock.advance(3600000)
  runtime = new ImportRuntime(path, 0, { ...clock, detailFreshnessMs: 60000 })
  runtimes.push(runtime)
  const next = request(runtime)
  expect(next.disposition).toBe('created')
  expect(await done(runtime, next.jobIds[0])).toMatchObject({
    counts: { checked: 1 },
  })
})

test('nonconcentric geographic containment includes tangency and excludes a small extension', async () => {
  const runtime = new ImportRuntime(
    join(directory, 'geodesic-boundary.sqlite'),
    0,
    testClock(0),
  )
  runtimes.push(runtime)
  const covering = { center: { latitude: 0, longitude: 0 }, radiusKm: 2 }
  await done(runtime, request(runtime, covering).jobIds[0])
  // 0.01 degrees on the equator is 1.1119492664455874 km on the documented sphere.
  const tangent = {
    center: { latitude: 0, longitude: 0.01 },
    radiusKm: 0.8880507335544126,
  }
  expect(request(runtime, tangent).disposition).toBe('cached')
  expect(request(runtime, { ...tangent, radiusKm: 0.8881 }).disposition).toBe(
    'created',
  )
})

test('near-antimeridian containment works and several overlapping scopes cannot imply union coverage', async () => {
  const runtime = new ImportRuntime(
    join(directory, 'union.sqlite'),
    0,
    testClock(0),
  )
  runtimes.push(runtime)
  const left = { center: { latitude: 0, longitude: 179.99 }, radiusKm: 4 }
  const first = await done(runtime, request(runtime, left).jobIds[0])
  expect(
    request(runtime, {
      center: { latitude: 0, longitude: -179.99 },
      radiusKm: 1,
    }),
  ).toMatchObject({ disposition: 'cached', jobIds: [first.id] })
  const right = { center: { latitude: 0, longitude: -179.99 }, radiusKm: 4 }
  await done(runtime, request(runtime, right).jobIds[0])
  expect(
    request(runtime, { center: { latitude: 0, longitude: 180 }, radiusKm: 4 })
      .disposition,
  ).toBe('created')
})

test('separate workers persist one idempotent cached reference without scheduling work', async () => {
  const path = join(directory, 'cached-race.sqlite')
  const clock = testClock(0)
  let calls = 0
  const options = {
    ...clock,
    transport: async () => {
      calls++
      return { status: 200 }
    },
  }
  const first = new ImportRuntime(path, 0, options)
  runtimes.push(first)
  const completed = await done(first, request(first).jobIds[0])
  const second = new ImportRuntime(path, 0, options)
  runtimes.push(second)
  const input = {
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'cached-race',
  }
  const references = await Promise.all([
    Promise.resolve().then(() => first.createRequest(input)),
    Promise.resolve().then(() => second.createRequest(input)),
  ])
  expect(references[0]).toEqual(references[1])
  expect(second.inspectRequest(references[0].id)).toMatchObject({
    disposition: 'cached',
    jobIds: [completed.id],
  })
  expect(first.list({ state: 'active' }).jobs).toEqual([])
  expect(calls).toBe(2)
})

test('source ordering changes retain the same set semantics and correct queued source outcomes', async () => {
  const path = join(directory, 'source-order.sqlite')
  const clock = testClock(0)
  const base = syntheticAdapter(0)
  const extra = {
    ...base,
    capabilities: { ...base.capabilities, sourceId: 'extra' },
    async discover(): Promise<never> {
      throw new Error('synthetic source failure')
    },
  }
  let runtime = new ImportRuntime(path, 0, {
    ...clock,
    adapters: [base, extra],
  })
  runtimes.push(runtime)
  const queued = request(runtime)
  await runtime.close()
  runtime = new ImportRuntime(path, 0, { ...clock, adapters: [extra, base] })
  runtimes.push(runtime)
  const job = await done(runtime, queued.jobIds[0])
  expect(job.state).toBe('partial')
  expect(job.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceId: 'fixture', state: 'succeeded' }),
      expect.objectContaining({ sourceId: 'extra', state: 'failed' }),
    ]),
  )
})

test('legacy interrupted progress recovers actual completed detail times instead of renewing them on restart', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const path = join(directory, 'legacy-progress.sqlite')
  const clock = testClock(0)
  const options = {
    ...clock,
    adapters: [syntheticAdapter(50, fixtures.slice(0, 2))],
  }
  let runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  const first = request(runtime)
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).counts.checked, {
      interval: 10,
    })
    .toBe(1)
  await runtime.close()
  const database = new DatabaseSync(path)
  // Simulate the durable progress shape retained by the previous runtime version.
  database
    .prepare(
      "UPDATE import_jobs_v2 SET progress=json_remove(progress,'$.oldestDetailCheckAt') WHERE id=?",
    )
    .run(first.jobIds[0])
  database.close()
  clock.advance(90000000)
  runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  const recovered = await done(runtime, first.jobIds[0])
  expect(recovered.state).toBe('succeeded')
  expect(recovered.coverage.freshUntil).toBe('1970-01-02T00:00:02.000Z')
  expect(request(runtime).disposition).toBe('created')
})
