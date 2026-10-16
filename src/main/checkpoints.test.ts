// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { LocalApiError } from './errors'
import { syntheticAdapter, type Candidate, type SourceAdapter } from './adapter'
import { initialArea } from '../shared/geography'
import { testClock } from './test-clock'

const directories: string[] = []
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function scenario(
  limits: { discoveryLimit?: number; detailLimit?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-checkpoint-'))
  directories.push(directory)
  const path = join(directory, 'db.sqlite')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const base = syntheticAdapter(0)
  let dates: (string | null)[] = [
    '2026-10-10T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ]
  let requests = 0
  const adapter: SourceAdapter = {
    ...base,
    capabilities: {
      ...base.capabilities,
      dateOrdering: {
        field: 'publishedAt',
        descendingVerified: true,
        overlapSeconds: 86400,
        evidence: 'Authored deterministic descending pages',
      },
    },
    async discover(input, context) {
      const template = await base.discover(
        { ...input, area: initialArea },
        context,
      )
      requests++
      const index = Number(input.cursor ?? 0)
      const candidate: Candidate = {
        ...template.candidates[0],
        externalId: `date-${index}`,
        publishedAt: dates[index],
      }
      return {
        candidates: [candidate],
        nextCursor: index + 1 < dates.length ? String(index + 1) : null,
        exhausted: index + 1 === dates.length,
        limitation: null,
      }
    },
  }
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    areaFreshnessMs: 0,
    ...limits,
    adapters: [adapter],
  })
  runtimes.push(runtime)
  let key = 0
  async function run(area = initialArea) {
    requests = 0
    const request = runtime.createRequest({
      area,
      intent: 'import',
      idempotencyKey: String(++key),
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    return runtime.inspect(request.jobIds[0])
  }
  return {
    runtime,
    adapter,
    path,
    clock,
    run,
    requests: () => requests,
    dates(value: (string | null)[]) {
      dates = value
    },
  }
}

test('initial traversal reads every page; completed scoped checkpoint consumes ties and overlap before stopping', async () => {
  const s = scenario()
  expect(await s.run()).toMatchObject({
    state: 'succeeded',
    budget: { discoveryUsed: 2 },
  })
  s.dates([
    '2026-10-11T00:00:00Z',
    '2026-10-10T00:00:00Z',
    '2026-10-10T00:00:00Z',
    '2026-10-09T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  expect(await s.run()).toMatchObject({
    state: 'succeeded',
    budget: { discoveryUsed: 5 },
    counts: { discovered: 4 },
  })
  expect(s.requests()).toBe(5)
})

test('stopping new-offer discovery still refreshes stale saved older offers and keeps failed detail work distinct', async () => {
  const s = scenario()
  await s.run()
  s.clock.advance(86400000)
  s.dates([
    '2026-10-11T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  const baseNormalize = s.adapter.normalize
  s.adapter.normalize = (evidence) => {
    const result = baseNormalize(evidence)
    if (result.kind === 'accepted' && evidence.identity.externalId === 'date-1')
      result.observation.fields.titleJa = 'Updated older offer'
    return result
  }
  expect(await s.run()).toMatchObject({
    state: 'succeeded',
    budget: { discoveryUsed: 2 },
    counts: { checked: 2, updated: 1 },
  })
  expect(
    s.runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ titleJa: 'Updated older offer' }),
    ]),
  )
})

test.each(['area', 'adapter', 'query', 'field', 'source'])(
  'an unrelated %s scope cannot borrow completed discovery',
  async (change) => {
    const s = scenario()
    await s.run()
    s.dates([
      '2026-10-11T00:00:00Z',
      '2026-10-08T00:00:00Z',
      '2026-10-01T00:00:00Z',
    ])
    const area =
      change === 'area' ? { ...initialArea, radiusKm: 4 } : initialArea
    if (change === 'adapter') s.adapter.capabilities.adapterVersion = 'v2'
    if (change === 'query') s.adapter.capabilities.queryVersion = 'v2'
    if (change === 'source') s.adapter.capabilities.sourceId = 'other'
    if (change === 'field')
      s.adapter.capabilities.dateOrdering!.field = 'modifiedAt'
    await s.run(area)
    expect(s.requests()).toBe(3)
  },
)

test.each(['missing', 'invalid', 'ascending', 'unsupported'])(
  '%s dates disable stopping and cannot create a reusable boundary',
  async (fault) => {
    const s = scenario()
    if (fault === 'unsupported') s.adapter.capabilities.dateOrdering = null
    else
      s.dates(
        fault === 'ascending'
          ? ['2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z']
          : ['2026-10-10T00:00:00Z', fault === 'missing' ? null : 'nonsense'],
      )
    await s.run()
    s.dates([
      '2026-10-11T00:00:00Z',
      '2026-10-08T00:00:00Z',
      '2026-10-01T00:00:00Z',
    ])
    await s.run()
    expect(s.requests()).toBe(3)
  },
)

test.each(['failed', 'cancelled', 'partial'])(
  '%s traversal cannot replace an earlier completed boundary',
  async (outcome) => {
    const s = scenario()
    await s.run()
    const discover = s.adapter.discover
    let page = 0
    s.dates(['2026-10-20T00:00:00Z', '2026-10-19T00:00:00Z'])
    s.adapter.discover = async (input, context) => {
      const result = await discover(input, context)
      if (++page === 2) {
        if (outcome === 'failed') throw new Error('Fixture traversal failure')
        if (outcome === 'cancelled')
          s.runtime.cancel(s.runtime.list({ state: 'active' }).jobs[0].id)
        if (outcome === 'partial')
          result.limitation = 'Fixture truncated traversal'
      }
      return result
    }
    expect((await s.run()).state).toBe(
      outcome === 'failed' ? 'partial' : outcome,
    )
    s.adapter.discover = discover
    s.dates([
      '2026-10-21T00:00:00Z',
      '2026-10-18T00:00:00Z',
      '2026-10-08T00:00:00Z',
      '2026-10-01T00:00:00Z',
    ])
    await s.run()
    expect(s.requests()).toBe(3)
  },
)

test('detail refresh failure retains complete discovery coverage without promoting a checkpoint or successful-check time', async () => {
  const s = scenario()
  await s.run()
  s.clock.advance(86400000)
  const normalize = s.adapter.normalize
  s.adapter.normalize = (evidence) =>
    evidence.identity.externalId === 'date-1'
      ? {
          kind: 'rejected',
          error: { code: 'PARSE_ERROR', message: 'Fixture', retryable: false },
        }
      : normalize(evidence)
  s.dates([
    '2026-10-20T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  expect(await s.run()).toMatchObject({
    state: 'partial',
    coverage: { status: 'complete', lastSuccessfulCheckAt: null },
  })
  s.adapter.normalize = normalize
  s.dates([
    '2026-10-21T00:00:00Z',
    '2026-10-18T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  await s.run()
  expect(s.requests()).toBe(3)
})

test('failed final transaction cannot publish a completed checkpoint and saved listings remain readable', async () => {
  const s = scenario()
  const fault = new DatabaseSync(s.path)
  fault.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON discovery_checkpoints BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END",
  )
  expect(await s.run()).toMatchObject({
    state: 'partial',
    counts: { added: 2 },
    coverage: { lastSuccessfulCheckAt: null },
  })
  expect(
    s.runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toHaveLength(2)
  fault.exec('DROP TRIGGER fail_checkpoint')
  fault.close()
  s.dates([
    '2026-10-11T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  await s.run()
  expect(s.requests()).toBe(3)
})

test('a rolled-back candidate commit cannot become traversal evidence for a future checkpoint', async () => {
  const s = scenario()
  const fault = new DatabaseSync(s.path)
  fault.exec(
    "CREATE TRIGGER fail_offer BEFORE INSERT ON listing_discovery_areas BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END",
  )
  expect(await s.run()).toMatchObject({
    state: 'failed',
    counts: { checked: 0, added: 0 },
  })
  expect(
    s.runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toHaveLength(0)
  fault.exec('DROP TRIGGER fail_offer')
  fault.close()
  s.dates([
    '2026-10-11T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  await s.run()
  expect(s.requests()).toBe(3)
})

test.each(['missing', 'ascending'])(
  '%s evidence encountered in a later scan disables an existing stopping boundary',
  async (fault) => {
    const s = scenario()
    await s.run()
    s.dates(
      fault === 'missing'
        ? [null, '2026-10-08T00:00:00Z', '2026-10-01T00:00:00Z']
        : [
            '2026-10-20T00:00:00Z',
            '2026-10-21T00:00:00Z',
            '2026-10-08T00:00:00Z',
            '2026-10-01T00:00:00Z',
          ],
    )
    await s.run()
    expect(s.requests()).toBe(fault === 'missing' ? 3 : 4)
  },
)

test('completed checkpoints survive worker restart and remain absent from renderer responses', async () => {
  const s = scenario()
  await s.run()
  await s.runtime.close()
  s.dates([
    '2026-10-11T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  const runtime = new ImportRuntime(s.path, 0, {
    ...s.clock,
    adapters: [s.adapter],
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'restarted',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).state)
    .toBe('succeeded')
  const job = runtime.inspect(request.jobIds[0])
  expect(job.budget.discoveryUsed).toBe(2)
  expect(
    JSON.stringify([
      request,
      job,
      runtime.results({ area: initialArea, showUnavailable: true }),
    ]),
  ).not.toMatch(
    /boundaryAt|stopBefore|newestAt|date_field|discovery_checkpoints/,
  )
})

test('completed bounded continuations promote the inherited newest date only after deferred details commit', async () => {
  const s = scenario({ discoveryLimit: 1, detailLimit: 1 })
  const discover = s.adapter.discover
  s.adapter.discover = async (input, context) => {
    const page = await discover(input, context)
    if (!input.cursor)
      page.candidates.push({
        ...page.candidates[0],
        externalId: 'deferred-tie',
      })
    return page
  }
  let job = await s.run()
  const original = job
  expect(job).toMatchObject({
    state: 'partial',
    continuation: { available: true },
  })
  while (job.continuation.available) {
    const next = s.runtime.createRequest({
      intent: 'continue',
      fromJobId: job.id,
      idempotencyKey: `continue-${job.id}`,
    })
    await expect
      .poll(() => s.runtime.inspect(next.jobIds[0]).stage)
      .toBe('finished')
    job = s.runtime.inspect(next.jobIds[0])
    expect(job.budget.discoveryUsed).toBeLessThanOrEqual(1)
    expect(job.budget.detailUsed).toBeLessThanOrEqual(1)
  }
  expect(job.state).toBe('succeeded')
  expect(s.runtime.inspect(original.id)).toEqual(original)
  await s.runtime.close()
  s.dates([
    '2026-10-11T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  const runtime = new ImportRuntime(s.path, 0, {
    ...s.clock,
    areaFreshnessMs: 0,
    adapters: [s.adapter],
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'verify-bounded',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'succeeded',
    budget: { discoveryUsed: 2 },
  })
})

test('invalid saved cursor abandons its newest date before a separately completed replacement promotes', async () => {
  const s = scenario({ discoveryLimit: 1 })
  s.dates(['2026-10-20T00:00:00Z', '2026-10-01T00:00:00Z'])
  const first = await s.run()
  const discover = s.adapter.discover
  let invalidated = false
  s.adapter.discover = async (input, context) => {
    if (input.cursor && !invalidated) {
      invalidated = true
      await context.request('discovery', 'https://example.invalid/expired')
      throw new LocalApiError(409, 'CURSOR_INVALID', 'Synthetic cursor invalid')
    }
    return discover(input, context)
  }
  s.dates(['2026-10-10T00:00:00Z', '2026-10-01T00:00:00Z'])
  let job = first
  for (let index = 0; index < 4 && job.continuation.available; index++) {
    const request = s.runtime.createRequest({
      intent: 'continue',
      fromJobId: job.id,
      idempotencyKey: `restart-${index}`,
    })
    await expect
      .poll(() => s.runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    job = s.runtime.inspect(request.jobIds[0])
    expect(job.budget.discoveryUsed).toBeLessThanOrEqual(1)
  }
  expect(job.state).toBe('succeeded')
  expect(invalidated).toBe(true)
  await s.runtime.close()
  s.dates([
    '2026-10-21T00:00:00Z',
    '2026-10-18T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  const runtime = new ImportRuntime(s.path, 0, {
    ...s.clock,
    areaFreshnessMs: 0,
    adapters: [s.adapter],
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'verify-restart',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'succeeded',
    budget: { discoveryUsed: 3 },
  })
})

test('a continuation retains completed source boundaries while another source finishes later', async () => {
  const s = scenario()
  await s.runtime.close()
  const second: SourceAdapter = {
    ...s.adapter,
    capabilities: { ...s.adapter.capabilities, sourceId: 'second' },
    async fetchDetail(candidate, context) {
      const evidence = await s.adapter.fetchDetail(candidate, context)
      return {
        ...evidence,
        identity: { ...evidence.identity, sourceId: 'second' },
      }
    },
  }
  const options = {
    ...s.clock,
    areaFreshnessMs: 0,
    adapters: [s.adapter, second],
  }
  let runtime = new ImportRuntime(s.path, 0, { ...options, discoveryLimit: 2 })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'two-source',
  })
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(first.jobIds[0]).sources[0].state).toBe('succeeded')
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: first.jobIds[0],
    idempotencyKey: 'two-source-next',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).state)
    .toBe('succeeded')
  await runtime.close()
  s.dates([
    '2026-10-11T00:00:00Z',
    '2026-10-08T00:00:00Z',
    '2026-10-01T00:00:00Z',
  ])
  runtime = new ImportRuntime(s.path, 0, options)
  runtimes.push(runtime)
  const verify = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'two-source-verify',
  })
  await expect
    .poll(() => runtime.inspect(verify.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(verify.jobIds[0])).toMatchObject({
    state: 'succeeded',
    budget: { discoveryUsed: 4 },
  })
})
