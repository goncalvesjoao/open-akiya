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
const directory = mkdtempSync(join(tmpdir(), 'refresh-reuse-'))
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
test.each([false, true])(
  'omitted known offer respects default detail freshness and changed fingerprint %s',
  async (changedVersion) => {
    const path = join(directory, `fingerprint-${changedVersion}.sqlite`)
    const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
    const seed = new ImportRuntime(path, 0, { ...clock, areaFreshnessMs: 0 })
    const original = await done(seed, request(seed).jobIds[0])
    const saved = seed.results(query).listings[0]
    await seed.close()
    const freshOffers = Array.from({ length: 2 }, (_, i) => {
      const url = `https://example.invalid/new-${i}`
      return {
        ...fixtures[0],
        primarySourceUrl: url,
        sourceRefs: [
          { ...fixtures[0].sourceRefs[0], externalId: `new-${i}`, url },
        ],
      }
    })
    const base = syntheticAdapter(0, [
      { ...fixtures[0], salePriceJpy: 777 },
      ...freshOffers,
    ])
    const adapter = {
      ...base,
      capabilities: {
        ...base.capabilities,
        adapterVersion: changedVersion
          ? 'v2'
          : base.capabilities.adapterVersion,
      },
      async discover(
        input: Parameters<typeof base.discover>[0],
        context: Parameters<typeof base.discover>[1],
      ) {
        const page = await base.discover(input, context)
        return {
          ...page,
          candidates: page.candidates.filter((candidate) =>
            candidate.externalId.startsWith('new-'),
          ),
        }
      },
    }
    const runtime = new ImportRuntime(path, 0, {
      ...clock,
      adapters: [adapter],
      detailLimit: changedVersion ? 3 : 2,
    })
    runtimes.push(runtime)
    const job = await done(runtime, request(runtime).jobIds[0])
    expect(job).toMatchObject({
      state: 'succeeded',
      budget: { detailUsed: changedVersion ? 3 : 2 },
      counts: {
        added: 2,
        updated: changedVersion ? 1 : 0,
        checked: changedVersion ? 3 : 2,
      },
    })
    const known = runtime
      .results(query)
      .listings.find((listing) => listing.id === saved.id)!
    expect(known.salePriceJpy).toBe(changedVersion ? 777 : 0)
    if (!changedVersion) {
      expect(known).toEqual(saved)
      expect(job.coverage.freshUntil).toBe(
        new Date(Date.parse(saved.sourceCheckedAt!) + 86400000).toISOString(),
      )
      expect(job.coverage.lastSuccessfulCheckAt).not.toBe(
        original.coverage.lastSuccessfulCheckAt,
      )
    }
  },
)

test('cancelling one attached request during reserved refresh keeps the other intent running', async () => {
  const path = join(directory, 'attached-refresh.sqlite')
  const clock = testClock(0)
  const seed = new ImportRuntime(path, 0, { ...clock, areaFreshnessMs: 0 })
  await done(seed, request(seed).jobIds[0])
  const saved = seed.results(query).listings
  await seed.close()
  clock.advance(86400000)
  let release: () => void = () => {}
  let refreshing = false
  let aborted = false
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    transport: async (url, options) => {
      if (url.includes('/offers/')) {
        refreshing = true
        options.signal!.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true },
        )
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return { status: 200 }
    },
  })
  runtimes.push(runtime)
  const first = request(runtime)
  const second = request(runtime)
  expect(second).toMatchObject({
    disposition: 'attached',
    jobIds: first.jobIds,
  })
  await expect.poll(() => refreshing).toBe(true)
  expect(await runtime.dispatch('cancelImportRequest', first.id)).toMatchObject(
    { state: 'cancelled' },
  )
  expect(runtime.inspectRequest(second.id).state).toBe('running')
  expect(aborted).toBe(false)
  release()
  await done(runtime, first.jobIds[0])
  expect(runtime.inspectRequest(first.id).state).toBe('cancelled')
  expect(runtime.inspectRequest(second.id).state).toBe('succeeded')
  expect(runtime.results(query).listings[0].id).toBe(saved[0].id)
})
