// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { fixtures } from './fixtures'
import { initialArea } from '../shared/geography'
import { testClock } from './test-clock'
const directory = mkdtempSync(join(tmpdir(), 'manual-refresh-'))
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
let sequence = 0
const query = { area: initialArea, showUnavailable: true }
function request(runtime: ImportRuntime) {
  return runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: String(++sequence),
  })
}
async function done(runtime: ImportRuntime, id: string) {
  await expect.poll(() => runtime.inspect(id).stage).toBe('finished')
  return runtime.inspect(id)
}
test('manual refresh bypasses area and detail freshness and a terminal refresh starts new intent', async () => {
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const runtime = new ImportRuntime(join(directory, 'direct.sqlite'), 0, clock)
  runtimes.push(runtime)
  const seeded = await done(runtime, request(runtime).jobIds[0])
  clock.advance(1)
  const refresh = () =>
    runtime.createRequest({
      area: initialArea,
      intent: 'manual_refresh',
      idempotencyKey: String(++sequence),
    })
  const manual = refresh()
  expect(manual.disposition).toBe('created')
  expect(refresh().id).toBe(manual.id)
  const job = await done(runtime, manual.jobIds[0])
  expect(job.state).toBe('succeeded')
  expect(job.counts.checked).toBe(seeded.counts.checked)
  expect(job.budget.discoveryUsed).toBeGreaterThan(0)
  expect(runtime.inspectRequest(manual.id)).toMatchObject({
    state: 'succeeded',
    pendingFollowUp: false,
  })
  expect(refresh().id).not.toBe(manual.id)
})

test('attached refresh remains pending for one bounded follow-up and keeps its original cutoff across restart and repeated clicks', async () => {
  const path = join(directory, 'attached.sqlite')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const seed = new ImportRuntime(path, 0, clock)
  await done(seed, request(seed).jobIds[0])
  await seed.close()
  clock.advance(1)
  let release!: () => void
  let discovering = false
  let following = false
  const base = syntheticAdapter(0, [{ ...fixtures[0], salePriceJpy: 777 }])
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    areaFreshnessMs: 0,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          discovering = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return base.discover(input, context)
        },
        async fetchDetail(candidate, context) {
          following = true
          await new Promise<void>((_, reject) =>
            context.signal.addEventListener(
              'abort',
              () => reject(context.signal.reason),
              { once: true },
            ),
          )
          return base.fetchDetail(candidate, context)
        },
      },
    ],
  })
  runtimes.push(runtime)
  const ordinary = request(runtime)
  await expect.poll(() => discovering).toBe(true)
  const manualInput = {
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'attached-manual',
  }
  const manual = runtime.createRequest(manualInput)
  expect(manual).toMatchObject({
    disposition: 'attached',
    pendingFollowUp: true,
    jobIds: ordinary.jobIds,
  })
  clock.advance(10000)
  const duplicate = runtime.createRequest({
    ...manualInput,
    idempotencyKey: 'attached-again',
  })
  expect(duplicate.id).toBe(manual.id)
  expect(() =>
    runtime.createRequest({
      ...manualInput,
      intent: 'import',
      idempotencyKey: 'attached-again',
    }),
  ).toThrow('Idempotency')
  const observer = new ImportRuntime(path, 0, { ...clock, adapters: [base] })
  runtimes.push(observer)
  expect(
    observer.createRequest({ ...manualInput, idempotencyKey: 'other-worker' })
      .id,
  ).toBe(manual.id)
  await observer.close()
  release()
  const ordinaryJob = await done(runtime, ordinary.jobIds[0])
  expect(ordinaryJob.counts.checked).toBe(0)
  await expect.poll(() => following).toBe(true)
  const pending = runtime.inspectRequest(manual.id)
  expect(pending.jobIds).toHaveLength(2)
  expect(pending).toMatchObject({
    state: 'running',
    pendingFollowUp: true,
    createdAt: manual.createdAt,
  })
  await runtime.close()
  const resumed = new ImportRuntime(path, 0, { ...clock, adapters: [base] })
  runtimes.push(resumed)
  expect(
    resumed.createRequest({ ...manualInput, idempotencyKey: 'after-restart' })
      .id,
  ).toBe(manual.id)
  const followUp = await done(resumed, pending.jobIds[1])
  expect(followUp).toMatchObject({
    state: 'succeeded',
    counts: { checked: 1 },
    budget: { discoveryUsed: 0, detailUsed: 1 },
  })
  expect(resumed.inspectRequest(manual.id)).toMatchObject({
    state: 'succeeded',
    pendingFollowUp: false,
    jobIds: pending.jobIds,
  })
  expect(
    resumed.createRequest({ ...manualInput, idempotencyKey: 'attached-again' })
      .id,
  ).toBe(manual.id)
  expect(resumed.results(query).listings[0].salePriceJpy).toBe(777)
})

test('bounded follow-up becomes partial without another automatic job and explicit continuation inherits its cutoff', async () => {
  const path = join(directory, 'bounded.sqlite')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const offers = Array.from({ length: 3 }, (_, i) => ({
    ...fixtures[0],
    sourceRefs: [
      {
        ...fixtures[0].sourceRefs[0],
        externalId: `bounded-${i}`,
        url: `https://example.invalid/bounded-${i}`,
      },
    ],
    primarySourceUrl: `https://example.invalid/bounded-${i}`,
  }))
  const base = syntheticAdapter(0, offers)
  const seed = new ImportRuntime(path, 0, { ...clock, adapters: [base] })
  await done(seed, request(seed).jobIds[0])
  await seed.close()
  clock.advance(1)
  let release!: () => void
  let discovering = false
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    areaFreshnessMs: 0,
    detailLimit: 1,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          discovering = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return base.discover(input, context)
        },
      },
    ],
  })
  runtimes.push(runtime)
  const ordinary = request(runtime)
  await expect.poll(() => discovering).toBe(true)
  const manual = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'bounded-manual',
  })
  release()
  await done(runtime, ordinary.jobIds[0])
  await expect
    .poll(() => runtime.inspectRequest(manual.id).state)
    .toBe('partial')
  const partial = runtime.inspectRequest(manual.id)
  expect(partial).toMatchObject({ pendingFollowUp: false })
  expect(partial.jobIds).toHaveLength(2)
  const followUp = runtime.inspect(partial.jobIds[1])
  expect(followUp).toMatchObject({
    counts: { checked: 1 },
    budget: { discoveryUsed: 0, detailUsed: 1 },
    continuation: { available: true },
  })
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
  for (let i = 0, fromJobId = followUp.id; i < 2; i++) {
    clock.advance(86400000)
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId,
      idempotencyKey: `bounded-next-${i}`,
    })
    const job = await done(runtime, next.jobIds[0])
    expect(job).toMatchObject({
      state: i === 0 ? 'partial' : 'succeeded',
      budget: { discoveryUsed: 0, detailUsed: 1 },
    })
    fromJobId = job.id
  }
  expect(runtime.inspectRequest(manual.id)).toEqual(partial)
  expect(runtime.results(query).coverage.status).toBe('complete')
})

test.each(['rejected', 'pre-cutoff'] as const)(
  'a %s manual recheck cannot clear its obligation or establish reusable coverage',
  async (failure) => {
    const path = join(directory, `rejected-${failure}.sqlite`)
    const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
    const seed = new ImportRuntime(path, 0, clock)
    await done(seed, request(seed).jobIds[0])
    const saved = seed.results(query).listings
    await seed.close()
    clock.advance(1)
    const base = syntheticAdapter(0)
    let reject = true
    const runtime = new ImportRuntime(path, 0, {
      ...clock,
      adapters: [
        {
          ...base,
          normalize(evidence) {
            const normalized = base.normalize(evidence)
            if (!reject) return normalized
            return failure === 'pre-cutoff' && normalized.kind === 'accepted'
              ? {
                  ...normalized,
                  observation: {
                    ...normalized.observation,
                    sourceCheckedAt: saved[0].sourceCheckedAt!,
                  },
                }
              : {
                  kind: 'rejected',
                  error: {
                    code: 'PARSE_ERROR',
                    message: 'Rejected synthetic offer',
                    retryable: false,
                  },
                }
          },
        },
      ],
    })
    runtimes.push(runtime)
    const manual = runtime.createRequest({
      area: initialArea,
      intent: 'manual_refresh',
      idempotencyKey: 'rejected-manual',
    })
    const failed = await done(runtime, manual.jobIds[0])
    expect(failed).toMatchObject({
      state: 'failed',
      coverage: { lastSuccessfulCheckAt: null, freshUntil: null },
      continuation: { available: true },
    })
    expect(runtime.results(query).listings).toEqual(saved)
    reject = false
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: failed.id,
      idempotencyKey: 'rejected-next',
    })
    const completed = await done(runtime, next.jobIds[0])
    expect(completed).toMatchObject({
      state: 'succeeded',
      counts: { checked: 1 },
      budget: { discoveryUsed: 0, detailUsed: 1 },
    })
  },
)

test.each(['attached', 'queued', 'running'] as const)(
  'cancelling a %s manual intent preserves shared work and cancels exclusive follow-up',
  async (stage) => {
    const path = join(directory, `cancel-${stage}.sqlite`)
    const clock = testClock(0)
    const seed = new ImportRuntime(path, 0, clock)
    await done(seed, request(seed).jobIds[0])
    await seed.close()
    clock.advance(1)
    const base = syntheticAdapter(0)
    let release!: () => void
    let discovering = false
    let following = false
    let discoveries = 0
    const runtime = new ImportRuntime(path, 0, {
      ...clock,
      areaFreshnessMs: 0,
      adapters: [
        {
          ...base,
          async discover(input, context) {
            discovering = true
            discoveries++
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return base.discover(input, context)
          },
          async fetchDetail(candidate, context) {
            following = true
            await new Promise<void>((_, reject) =>
              context.signal.addEventListener(
                'abort',
                () => reject(context.signal.reason),
                { once: true },
              ),
            )
            return base.fetchDetail(candidate, context)
          },
        },
      ],
    })
    runtimes.push(runtime)
    const ordinary = request(runtime)
    await expect.poll(() => discovering).toBe(true)
    const manual = runtime.createRequest({
      area: initialArea,
      intent: 'manual_refresh',
      idempotencyKey: `cancel-${stage}`,
    })
    if (stage === 'attached') {
      await runtime.dispatch('cancelImportRequest', manual.id)
      release()
      expect((await done(runtime, ordinary.jobIds[0])).state).toBe('succeeded')
      expect(runtime.inspectRequest(manual.id)).toMatchObject({
        state: 'cancelled',
        pendingFollowUp: false,
        jobIds: ordinary.jobIds,
      })
    } else {
      // A second queued area prevents the follow-up from dispatching until cancellation is observed.
      if (stage === 'queued')
        runtime.createRequest({
          area: { ...initialArea, center: { latitude: 36, longitude: 136 } },
          intent: 'import',
          idempotencyKey: 'blocker',
        })
      release()
      if (stage === 'queued')
        await expect
          .poll(() => runtime.inspectRequest(manual.id).jobIds.length)
          .toBe(2)
      else await expect.poll(() => following).toBe(true)
      const linked = runtime.inspectRequest(manual.id).jobIds
      await runtime.dispatch('cancelImportRequest', manual.id)
      expect((await done(runtime, linked[1])).state).toBe('cancelled')
      expect(runtime.inspect(ordinary.jobIds[0]).state).toBe('succeeded')
      expect(runtime.inspectRequest(manual.id)).toMatchObject({
        state: 'cancelled',
        pendingFollowUp: false,
        jobIds: linked,
      })
      // Release any unrelated discovery before closing this test runtime.
      if (stage === 'queued') {
        await expect.poll(() => discoveries).toBe(2)
        release()
      }
    }
    await runtime.close()
    const recovered = new ImportRuntime(path, 0, clock)
    runtimes.push(recovered)
    const cancelled = recovered.inspectRequest(manual.id)
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      pendingFollowUp: false,
    })
    expect(
      recovered
        .list({ state: 'active' })
        .jobs.some((job) => cancelled.jobIds.includes(job.id)),
    ).toBe(false)
    expect(recovered.results(query).listings).toHaveLength(1)
  },
)

test('settlement rollback cannot duplicate a follow-up or publish premature manual success', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const path = join(directory, 'settlement.sqlite')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const base = syntheticAdapter(0)
  let release!: () => void
  let blocked = false
  let block = false
  const adapter = {
    ...base,
    capabilities: {
      ...base.capabilities,
      dateOrdering: {
        field: 'publishedAt' as const,
        descendingVerified: true as const,
        overlapSeconds: 86400,
        evidence: 'Deterministic test ordering',
      },
    },
    async discover(
      input: Parameters<typeof base.discover>[0],
      context: Parameters<typeof base.discover>[1],
    ) {
      if (block) {
        blocked = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      const page = await base.discover(input, context)
      return {
        ...page,
        candidates: page.candidates.map((candidate) => ({
          ...candidate,
          publishedAt: '2026-10-15T00:00:00Z',
        })),
      }
    },
  }
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    areaFreshnessMs: 0,
    adapters: [adapter],
  })
  runtimes.push(runtime)
  await done(runtime, request(runtime).jobIds[0])
  clock.advance(1)
  block = true
  const ordinary = request(runtime)
  await expect.poll(() => blocked).toBe(true)
  const manual = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'settlement-manual',
  })
  const fault = new DatabaseSync(path)
  fault.exec(
    `CREATE TRIGGER fail_settlement BEFORE INSERT ON discovery_checkpoints WHEN EXISTS (SELECT 1 FROM import_jobs_v2 WHERE id='${ordinary.jobIds[0]}' AND state='succeeded') BEGIN SELECT RAISE(ABORT,'synthetic settlement failure'); END`,
  )
  release()
  expect((await done(runtime, ordinary.jobIds[0])).state).toBe('failed')
  await expect
    .poll(() => runtime.inspectRequest(manual.id).state)
    .toBe('succeeded')
  const settled = runtime.inspectRequest(manual.id)
  expect(settled.jobIds).toHaveLength(2)
  expect(runtime.inspect(settled.jobIds[1])).toMatchObject({
    counts: { checked: 1 },
    budget: { discoveryUsed: 0 },
    state: 'succeeded',
  })
  expect(settled.pendingFollowUp).toBe(false)
  fault.close()
})

test('manual refresh shares the bounded detail allocation with newly discovered offers', async () => {
  const path = join(directory, 'allocation.sqlite')
  const clock = testClock(0)
  const offer = (id: string) => ({
    ...fixtures[0],
    sourceRefs: [
      {
        ...fixtures[0].sourceRefs[0],
        externalId: id,
        url: `https://example.invalid/${id}`,
      },
    ],
    primarySourceUrl: `https://example.invalid/${id}`,
  })
  const seed = new ImportRuntime(path, 0, {
    ...clock,
    adapters: [syntheticAdapter(0, [offer('old-a'), offer('old-b')])],
  })
  await done(seed, request(seed).jobIds[0])
  await seed.close()
  clock.advance(1)
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    detailLimit: 2,
    adapters: [
      syntheticAdapter(0, [
        offer('old-a'),
        offer('old-b'),
        offer('new-a'),
        offer('new-b'),
      ]),
    ],
  })
  runtimes.push(runtime)
  const manual = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'allocation-manual',
  })
  const job = await done(runtime, manual.jobIds[0])
  expect(job).toMatchObject({
    state: 'partial',
    counts: { checked: 2, added: 1, unchanged: 1 },
    budget: { detailUsed: 2 },
    continuation: { available: true },
  })
})

test('successful ordinary checks since the first refresh click satisfy that intent even after later clicks', async () => {
  const path = join(directory, 'successful-checks.sqlite')
  const clock = testClock(0)
  const base = syntheticAdapter(0)
  let page = 0
  let release!: () => void
  let waiting = 0
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          waiting++
          await new Promise<void>((resolve) => {
            release = resolve
          })
          const result = await base.discover(
            { ...input, cursor: null },
            context,
          )
          return page++ === 0
            ? { ...result, exhausted: false, nextCursor: 'tail' }
            : { ...result, candidates: [] }
        },
      },
    ],
  })
  runtimes.push(runtime)
  const ordinary = request(runtime)
  await expect.poll(() => waiting).toBe(1)
  const manual = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'check-first',
  })
  release()
  await expect.poll(() => waiting).toBe(2)
  const checked = runtime.results(query).listings[0].sourceCheckedAt
  clock.advance(10000)
  const duplicate = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'check-later',
  })
  expect(duplicate.id).toBe(manual.id)
  expect(Date.parse(checked!)).toBeLessThan(clock.now())
  release()
  await done(runtime, ordinary.jobIds[0])
  expect(runtime.inspectRequest(manual.id)).toMatchObject({
    state: 'succeeded',
    pendingFollowUp: false,
    jobIds: ordinary.jobIds,
  })
  expect(runtime.inspect(ordinary.jobIds[0]).budget.detailUsed).toBe(1)
})

test('a contained refresh follow-up keeps its requested area and cannot establish broader coverage', async () => {
  const path = join(directory, 'contained.sqlite')
  const clock = testClock(0)
  const seed = new ImportRuntime(path, 0, clock)
  await done(seed, request(seed).jobIds[0])
  await seed.close()
  clock.advance(1)
  const base = syntheticAdapter(0)
  let release!: () => void
  let waiting = false
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    areaFreshnessMs: 0,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          waiting = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return base.discover(input, context)
        },
      },
    ],
  })
  runtimes.push(runtime)
  const ordinary = request(runtime)
  await expect.poll(() => waiting).toBe(true)
  const area = { ...initialArea, radiusKm: 1 }
  const manual = runtime.createRequest({
    area,
    intent: 'manual_refresh',
    idempotencyKey: 'contained',
  })
  release()
  await done(runtime, ordinary.jobIds[0])
  await expect
    .poll(() => runtime.inspectRequest(manual.id).state)
    .toBe('succeeded')
  const followUp = runtime.inspect(runtime.inspectRequest(manual.id).jobIds[1])
  expect(followUp.area).toEqual(area)
  expect(followUp.budget.discoveryUsed).toBe(0)
  expect(
    runtime.results({ area, showUnavailable: true }).coverage
      .lastSuccessfulCheckAt,
  ).toBe(followUp.finishedAt)
  expect(runtime.results(query).coverage.lastSuccessfulCheckAt).toBe(
    runtime.inspect(ordinary.jobIds[0]).finishedAt,
  )
})

test('ordinary cache reuse at dispatch cannot complete an attached manual request after restart', async () => {
  const path = join(directory, 'dispatch-cache.sqlite')
  const clock = testClock(0)
  const seed = new ImportRuntime(path, 0, clock)
  await done(seed, request(seed).jobIds[0])
  await seed.close()
  clock.advance(1)
  const queued = new ImportRuntime(path, 0, { ...clock, areaFreshnessMs: 0 })
  const ordinary = request(queued)
  const manual = queued.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'dispatch-manual',
  })
  await queued.close()
  const runtime = new ImportRuntime(path, 0, clock)
  runtimes.push(runtime)
  expect((await done(runtime, ordinary.jobIds[0])).reasons).toEqual([
    'CACHE_REUSED',
  ])
  await expect
    .poll(() => runtime.inspectRequest(manual.id).state)
    .toBe('succeeded')
  const settled = runtime.inspectRequest(manual.id)
  expect(settled).toMatchObject({
    disposition: 'attached',
    pendingFollowUp: false,
  })
  expect(settled.jobIds).toHaveLength(2)
  expect(runtime.inspect(settled.jobIds[1])).toMatchObject({
    counts: { checked: 1 },
    budget: { discoveryUsed: 0, detailUsed: 1 },
  })
})
