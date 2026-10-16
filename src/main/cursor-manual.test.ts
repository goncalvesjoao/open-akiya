// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { LocalApiError } from './errors'
import { syntheticAdapter } from './adapter'
import { fixtures } from './fixtures'
import { initialArea } from '../shared/geography'
import { testClock } from './test-clock'

const runtimes: ImportRuntime[] = []
const directories: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

test.each(['CURSOR_EXPIRED', 'CURSOR_INVALID'])(
  '%s preserves the manual cutoff and deferred obligations across exhausted restart and database reopen',
  async (code) => {
    const directory = mkdtempSync(join(tmpdir(), 'manual-cursor-'))
    directories.push(directory)
    const path = join(directory, 'db.sqlite')
    const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
    const offers = ['a', 'b', 'c'].map((externalId) => ({
      ...fixtures[0],
      primarySourceUrl: `https://example.invalid/${externalId}`,
      sourceRefs: [
        {
          ...fixtures[0].sourceRefs[0],
          externalId,
          url: `https://example.invalid/${externalId}`,
        },
      ],
    }))
    const base = syntheticAdapter(0, offers)
    let runtime = new ImportRuntime(path, 0, { ...clock, adapters: [base] })
    runtimes.push(runtime)
    const seed = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'seed',
    })
    await expect
      .poll(() => runtime.inspect(seed.jobIds[0]).stage)
      .toBe('finished')
    const query = { area: initialArea, showUnavailable: true }
    const saved = runtime.results(query).listings
    await runtime.close()
    clock.advance(1)
    let replacement = false
    const details: string[] = []
    const discoveries: (string | null)[] = []
    const options = {
      ...clock,
      discoveryLimit: 1,
      detailLimit: 1,
      adapters: [
        {
          ...base,
          async discover(
            input: Parameters<typeof base.discover>[0],
            context: Parameters<typeof base.discover>[1],
          ) {
            if (input.cursor) {
              await context.request(
                'discovery',
                'https://example.invalid/rejected',
              )
              discoveries.push(input.cursor)
              throw new LocalApiError(
                409,
                code,
                'Synthetic saved cursor rejected',
              )
            }
            const page = await base.discover(input, context)
            discoveries.push(input.cursor)
            return replacement
              ? page
              : {
                  ...page,
                  candidates: page.candidates.slice(0, 1),
                  nextCursor: 'saved',
                  exhausted: false,
                }
          },
          async fetchDetail(
            candidate: Parameters<typeof base.fetchDetail>[0],
            context: Parameters<typeof base.fetchDetail>[1],
          ) {
            details.push(candidate.externalId)
            return base.fetchDetail(candidate, context)
          },
        },
      ],
    }
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    const manual = runtime.createRequest({
      area: initialArea,
      intent: 'manual_refresh',
      idempotencyKey: 'manual',
    })
    await expect
      .poll(() => runtime.inspect(manual.jobIds[0]).stage)
      .toBe('finished')
    const original = runtime.inspect(manual.jobIds[0])
    expect(original).toMatchObject({
      state: 'partial',
      counts: { checked: 1 },
      continuation: { available: true },
    })
    expect(runtime.inspectRequest(manual.id)).toMatchObject({
      state: 'partial',
      pendingFollowUp: false,
    })
    const checkedA = runtime
      .results(query)
      .listings.find(
        (listing) => listing.sourceRefs[0].externalId === 'a',
      )!.sourceCheckedAt
    await runtime.close()
    replacement = true
    clock.advance(2 * 86400000)
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    const continued = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.id,
      idempotencyKey: 'continue',
    })
    await expect
      .poll(() => runtime.inspect(continued.jobIds[0]).stage)
      .toBe('finished')
    const restarted = runtime.inspect(continued.jobIds[0])
    expect(restarted).toMatchObject({
      state: 'partial',
      counts: { checked: 1 },
      budget: { discoveryUsed: 1, detailUsed: 1 },
      reasons: expect.arrayContaining([code, 'BUDGET_EXHAUSTED']),
      continuation: { available: true, restarted: true, restartReason: code },
    })
    expect(details).toEqual(['a', 'b'])
    expect(runtime.list({ state: 'active' }).jobs).toEqual([])
    await runtime.close()
    clock.advance(2 * 86400000)
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    const final = runtime.createRequest({
      intent: 'continue',
      fromJobId: restarted.id,
      idempotencyKey: 'finish',
    })
    await expect
      .poll(() => runtime.inspect(final.jobIds[0]).stage)
      .toBe('finished')
    const completed = runtime.inspect(final.jobIds[0])
    expect(completed).toMatchObject({
      state: 'succeeded',
      counts: { checked: 1, added: 0 },
      budget: { discoveryUsed: 1, detailUsed: 1 },
      coverage: { status: 'complete' },
      reasons: [code],
      continuation: { available: false, restarted: true, restartReason: code },
    })
    expect(details).toEqual(['a', 'b', 'c'])
    expect(discoveries).toEqual([null, 'saved', null])
    const results = runtime.results(query).listings
    expect(results.map((listing) => listing.id).sort()).toEqual(
      saved.map((listing) => listing.id).sort(),
    )
    for (const listing of results)
      expect(Date.parse(listing.sourceCheckedAt!)).toBeGreaterThanOrEqual(
        Date.parse(manual.createdAt),
      )
    expect(
      results.find((listing) => listing.sourceRefs[0].externalId === 'a')!
        .sourceCheckedAt,
    ).toBe(checkedA)
    expect(runtime.inspect(original.id)).toEqual(original)
    expect(runtime.inspectRequest(manual.id)).toMatchObject({
      state: 'partial',
      pendingFollowUp: false,
    })
    expect(runtime.inspectRequest(final.id)).toMatchObject({
      state: 'succeeded',
      pendingFollowUp: false,
    })
    await runtime.close()
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    expect(runtime.inspect(final.jobIds[0])).toEqual(completed)
  },
)

test('attached manual follow-up stays partial after cursor rejection and explicit continuation reuses its post-cutoff check', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'attached-cursor-'))
  directories.push(directory)
  const path = join(directory, 'db.sqlite')
  const clock = testClock(0)
  const base = syntheticAdapter(0)
  const seed = new ImportRuntime(path, 0, clock)
  const seeded = seed.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'seed',
  })
  await expect.poll(() => seed.inspect(seeded.jobIds[0]).stage).toBe('finished')
  await seed.close()
  clock.advance(1)
  let blocked = false
  let release!: () => void
  let replacement = false
  const options = {
    ...clock,
    areaFreshnessMs: 0,
    discoveryLimit: 1,
    detailLimit: 1,
    adapters: [
      {
        ...base,
        async discover(
          input: Parameters<typeof base.discover>[0],
          context: Parameters<typeof base.discover>[1],
        ) {
          if (input.cursor) {
            await context.request(
              'discovery',
              'https://example.invalid/expired',
            )
            throw new LocalApiError(
              409,
              'CURSOR_EXPIRED',
              'Synthetic saved cursor expired',
            )
          }
          if (!replacement && !blocked) {
            blocked = true
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          const page = await base.discover(input, context)
          return replacement
            ? page
            : { ...page, nextCursor: 'saved', exhausted: false }
        },
      },
    ],
  }
  let runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  const ordinary = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'ordinary',
  })
  await expect.poll(() => blocked).toBe(true)
  const manual = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'manual',
  })
  expect(manual).toMatchObject({
    disposition: 'attached',
    pendingFollowUp: true,
    jobIds: ordinary.jobIds,
  })
  release()
  await expect
    .poll(() => runtime.inspectRequest(manual.id).state)
    .toBe('partial')
  const partial = runtime.inspectRequest(manual.id)
  expect(partial).toMatchObject({ pendingFollowUp: false })
  expect(partial.jobIds).toHaveLength(2)
  const followUp = runtime.inspect(partial.jobIds[1])
  expect(followUp).toMatchObject({
    state: 'partial',
    budget: { discoveryUsed: 1, detailUsed: 1 },
    counts: { checked: 1 },
    continuation: {
      available: true,
      restarted: true,
      restartReason: 'CURSOR_EXPIRED',
    },
  })
  const checked = runtime.results({ area: initialArea, showUnavailable: true })
    .listings[0].sourceCheckedAt
  expect(Date.parse(checked!)).toBeGreaterThanOrEqual(
    Date.parse(manual.createdAt),
  )
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
  await runtime.close()
  replacement = true
  clock.advance(2 * 86400000)
  runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  const continued = runtime.createRequest({
    intent: 'continue',
    fromJobId: followUp.id,
    idempotencyKey: 'continued',
  })
  await expect
    .poll(() => runtime.inspect(continued.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(continued.jobIds[0])).toMatchObject({
    state: 'succeeded',
    budget: { discoveryUsed: 1, detailUsed: 0 },
    counts: { checked: 0 },
    coverage: { status: 'complete' },
    continuation: {
      restarted: true,
      restartReason: 'CURSOR_EXPIRED',
      available: false,
    },
  })
  expect(runtime.inspectRequest(continued.id)).toMatchObject({
    state: 'succeeded',
    pendingFollowUp: false,
  })
  expect(runtime.inspectRequest(manual.id)).toEqual(partial)
  const results = runtime.results({
    area: initialArea,
    showUnavailable: true,
  }).listings
  expect(results).toHaveLength(1)
  expect(results[0].sourceCheckedAt).toBe(checked)
})
