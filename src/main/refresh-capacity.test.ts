// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { fixtures } from './fixtures'
import { initialArea } from '../shared/geography'
import { testClock } from './test-clock'
// Allocation fixtures disable reuse so each ordinary import exercises stale work.
const directory = mkdtempSync(join(tmpdir(), 'refresh-capacity-'))
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
let sequence = 0
async function imported(runtime: ImportRuntime) {
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: String(++sequence),
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  return runtime.inspect(request.jobIds[0])
}
test('reserves a detail for an older known offer omitted by abundant discovery', async () => {
  const path = join(directory, 'mixed.sqlite')
  const clock = testClock(0)
  const seed = new ImportRuntime(path, 0, { ...clock })
  await imported(seed)
  await seed.close()
  const older = { ...fixtures[0], salePriceJpy: 1234 }
  const offers = [
    older,
    ...Array.from({ length: 8 }, (_, i) => ({
      ...fixtures[0],
      id: `new-${i}`,
      sourceRefs: [
        {
          ...fixtures[0].sourceRefs[0],
          externalId: `new-${i}`,
          url: `https://example.invalid/offers/new-${i}`,
        },
      ],
      primarySourceUrl: `https://example.invalid/offers/new-${i}`,
    })),
  ]
  const base = syntheticAdapter(0, offers)
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    detailLimit: 4,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          const page = await base.discover(input, context)
          return {
            ...page,
            candidates: page.candidates.filter(
              (candidate) =>
                candidate.externalId !== older.sourceRefs[0].externalId,
            ),
          }
        },
      },
    ],
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    budget: { detailUsed: 4 },
    counts: { updated: 1, added: 3 },
  })
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ salePriceJpy: 1234 })]),
  )
})

test('selects the oldest successful checks across sources before abundant new work', async () => {
  const path = join(directory, 'global.sqlite')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  function offer(sourceId: string, externalId: string) {
    const url = `https://example.invalid/${sourceId}/${externalId}`
    return {
      ...fixtures[0],
      id: externalId,
      primarySourceUrl: url,
      sourceRefs: [{ ...fixtures[0].sourceRefs[0], sourceId, externalId, url }],
    }
  }
  let refresh = false
  const sourceOffers = [
    [offer('first', 'a-old'), offer('first', 'a-young')],
    [offer('second', 'b-old'), offer('second', 'b-young')],
  ]
  const dates: Record<string, string> = {
    'a-old': '2026-10-02T00:00:00Z',
    'a-young': '2026-10-04T00:00:00Z',
    'b-old': '2026-10-01T00:00:00Z',
    'b-young': '2026-10-03T00:00:00Z',
  }
  const adapters = sourceOffers.map((known, index) => {
    const base = syntheticAdapter(0, [
      ...known,
      ...Array.from({ length: 8 }, (_, i) =>
        offer(index ? 'second' : 'first', `new-${index}-${i}`),
      ),
    ])
    return {
      ...base,
      async discover(
        input: Parameters<typeof base.discover>[0],
        context: Parameters<typeof base.discover>[1],
      ) {
        const page = await base.discover(input, context)
        return {
          ...page,
          candidates: page.candidates.filter((candidate) =>
            refresh
              ? candidate.externalId.startsWith('new-')
              : !candidate.externalId.startsWith('new-'),
          ),
        }
      },
      normalize(evidence: Parameters<typeof base.normalize>[0]) {
        const result = base.normalize(evidence)
        if (result.kind === 'accepted') {
          result.observation.sourceCheckedAt =
            dates[evidence.identity.externalId] ?? evidence.fetchedAt
          if (refresh) result.observation.fields.salePriceJpy = 999
        }
        return result
      },
    }
  })
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters,
  })
  await imported(seed)
  await seed.close()
  refresh = true
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters,
    detailLimit: 8,
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    budget: { detailUsed: 8 },
    counts: { updated: 2, added: 6 },
  })
  const listings = runtime.results({
    area: initialArea,
    showUnavailable: true,
  }).listings
  expect(
    listings
      .filter(
        (listing) =>
          listing.salePriceJpy === 999 &&
          !listing.sourceRefs[0].externalId.startsWith('new-'),
      )
      .map((listing) => listing.sourceRefs[0].externalId)
      .sort(),
  ).toEqual(['a-old', 'b-old'])
})

test('a blocked refresh retains its saved result without starving another source refresh', async () => {
  const path = join(directory, 'blocked.sqlite')
  const clock = testClock(0)
  const other = {
    ...fixtures[0],
    primarySourceUrl: 'https://example.invalid/other',
    sourceRefs: [
      {
        ...fixtures[0].sourceRefs[0],
        sourceId: 'other',
        url: 'https://example.invalid/other',
      },
    ],
  }
  let phase = false
  const adapters = [syntheticAdapter(0), syntheticAdapter(0, [other])].map(
    (base) => ({
      ...base,
      normalize(evidence: Parameters<typeof base.normalize>[0]) {
        const result = base.normalize(evidence)
        if (phase && result.kind === 'accepted')
          result.observation.fields.salePriceJpy = 777
        return result
      },
    }),
  )
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters,
  })
  await imported(seed)
  await seed.close()
  phase = true
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters,
    detailLimit: 4,
    refreshReservation: 0.5,
    transport: async (url) => ({
      status: url.includes('/offers/') ? 403 : 200,
    }),
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { updated: 1 },
    budget: { detailUsed: 2 },
  })
  expect(
    runtime
      .results({ area: initialArea, showUnavailable: true })
      .listings.map((listing) => listing.salePriceJpy)
      .sort(),
  ).toEqual([0, 777])
})

test.each([0, 0.75, 1])(
  'releases unused refresh capacity with reservation %s',
  async (refreshReservation) => {
    const clock = testClock(0)
    const offers = Array.from({ length: 4 }, (_, i) => {
      const url = `https://example.invalid/offers/new-${i}`
      return {
        ...fixtures[0],
        primarySourceUrl: url,
        sourceRefs: [
          { ...fixtures[0].sourceRefs[0], externalId: `new-${i}`, url },
        ],
      }
    })
    const runtime = new ImportRuntime(
      join(directory, `release-${refreshReservation}.sqlite`),
      0,
      {
        areaFreshnessMs: 0,
        detailFreshnessMs: 0,
        ...clock,
        detailLimit: 4,
        refreshReservation,
        adapters: [syntheticAdapter(0, offers)],
      },
    )
    runtimes.push(runtime)
    expect(await imported(runtime)).toMatchObject({
      state: 'succeeded',
      counts: { added: 4 },
      budget: { detailUsed: 4 },
    })
  },
)

test('a refresh retry chain cannot consume the new-offer reservation', async () => {
  const path = join(directory, 'retries.sqlite')
  const clock = testClock(0)
  const seed = new ImportRuntime(path, 0, { ...clock })
  await imported(seed)
  await seed.close()
  const known = fixtures[0]
  const url = 'https://example.invalid/new'
  const base = syntheticAdapter(0, [
    known,
    {
      ...known,
      primarySourceUrl: url,
      sourceRefs: [{ ...known.sourceRefs[0], externalId: 'new', url }],
    },
  ])
  let refreshAttempts = 0
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    detailLimit: 2,
    adapters: [base],
    transport: async (url) => {
      if (url.includes('/offers/')) {
        refreshAttempts++
        return { status: 503 }
      }
      return { status: 200 }
    },
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { added: 1 },
    budget: { detailUsed: 2 },
  })
  expect(refreshAttempts).toBe(1)
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toHaveLength(2)
})

test.each([-0.1, 1.1, Infinity, NaN])(
  'rejects invalid refresh reservation %s before creating jobs',
  (refreshReservation) => {
    expect(
      () => new ImportRuntime(':memory:', 0, { refreshReservation }),
    ).toThrow('Invalid refresh reservation')
  },
)

test('releases unused new-offer capacity to all remaining known refreshes', async () => {
  const path = join(directory, 'refresh-only.sqlite')
  const clock = testClock(0)
  const offers = Array.from({ length: 4 }, (_, i) => {
    const url = `https://example.invalid/offers/${i}`
    return {
      ...fixtures[0],
      primarySourceUrl: url,
      sourceRefs: [
        { ...fixtures[0].sourceRefs[0], externalId: String(i), url },
      ],
    }
  })
  let changed = false
  const base = syntheticAdapter(0, offers)
  const adapter = {
    ...base,
    normalize(evidence: Parameters<typeof base.normalize>[0]) {
      const result = base.normalize(evidence)
      if (changed && result.kind === 'accepted')
        result.observation.fields.salePriceJpy = 444
      return result
    },
  }
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [adapter],
  })
  await imported(seed)
  await seed.close()
  changed = true
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    detailLimit: 4,
    adapters: [adapter],
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'succeeded',
    counts: { updated: 4 },
    budget: { detailUsed: 4 },
  })
})

test('restart retains committed refreshes and accounts an interrupted refresh attempt', async () => {
  const path = join(directory, 'restart-refresh.sqlite')
  const clock = testClock(0)
  const secondUrl = 'https://example.invalid/offers/second'
  const offers = [
    fixtures[0],
    {
      ...fixtures[0],
      primarySourceUrl: secondUrl,
      sourceRefs: [
        { ...fixtures[0].sourceRefs[0], externalId: 'second', url: secondUrl },
      ],
    },
  ]
  const adapter = syntheticAdapter(0, offers)
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [adapter],
  })
  await imported(seed)
  await seed.close()
  let waiting = false
  const first = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [adapter],
    transport: async (url, options) => {
      if (url === secondUrl) {
        waiting = true
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        )
        options.signal!.throwIfAborted()
      }
      return { status: 200 }
    },
  })
  const request = first.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'restart-refresh',
  })
  await expect.poll(() => waiting).toBe(true)
  const checked = first
    .results({ area: initialArea, showUnavailable: true })
    .listings.find(
      (listing) =>
        listing.sourceRefs[0].externalId ===
        fixtures[0].sourceRefs[0].externalId,
    )!.sourceCheckedAt
  await first.close()
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [adapter],
  })
  runtimes.push(runtime)
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).state)
    .toBe('succeeded')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    counts: { checked: 2, unchanged: 2 },
    budget: { detailUsed: 3 },
  })
  expect(
    runtime
      .results({ area: initialArea, showUnavailable: true })
      .listings.find(
        (listing) =>
          listing.sourceRefs[0].externalId ===
          fixtures[0].sourceRefs[0].externalId,
      )!.sourceCheckedAt,
  ).toBe(checked)
})

test('a rejected tail refresh cannot report success or advance its saved check time', async () => {
  const path = join(directory, 'tail-rejected.sqlite')
  const clock = testClock(0)
  const url = 'https://example.invalid/offers/second'
  const offers = [
    fixtures[0],
    {
      ...fixtures[0],
      primarySourceUrl: url,
      sourceRefs: [{ ...fixtures[0].sourceRefs[0], externalId: 'second', url }],
    },
  ]
  const base = syntheticAdapter(0, offers)
  let reject = false
  const adapter = {
    ...base,
    normalize(evidence: Parameters<typeof base.normalize>[0]) {
      return reject && evidence.identity.externalId === 'second'
        ? {
            kind: 'rejected' as const,
            error: {
              code: 'PARSE_ERROR',
              message: 'Synthetic rejected refresh',
              retryable: false,
            },
          }
        : base.normalize(evidence)
    },
  }
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [adapter],
  })
  await imported(seed)
  const saved = seed
    .results({ area: initialArea, showUnavailable: true })
    .listings.find((listing) => listing.sourceRefs[0].externalId === 'second')
  await seed.close()
  reject = true
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    detailLimit: 2,
    adapters: [adapter],
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { checked: 2, rejected: 1, unchanged: 1 },
    sources: [
      {
        state: 'partial',
        coverage: 'complete',
        error: { code: 'PARSE_ERROR' },
      },
    ],
  })
  expect(
    runtime
      .results({ area: initialArea, showUnavailable: true })
      .listings.find(
        (listing) => listing.sourceRefs[0].externalId === 'second',
      ),
  ).toEqual(saved)
})

test('a storage failure in released refresh capacity rolls back its check and outcome counts', async () => {
  const path = join(directory, 'tail-storage.sqlite')
  const clock = testClock(0)
  const url = 'https://example.invalid/offers/second'
  const offers = [
    fixtures[0],
    {
      ...fixtures[0],
      primarySourceUrl: url,
      sourceRefs: [{ ...fixtures[0].sourceRefs[0], externalId: 'second', url }],
    },
  ]
  const adapter = syntheticAdapter(0, offers)
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [adapter],
  })
  await imported(seed)
  const saved = seed
    .results({ area: initialArea, showUnavailable: true })
    .listings.find((listing) => listing.sourceRefs[0].externalId === 'second')
  await seed.close()
  const db = new DatabaseSync(path)
  db.exec(
    "CREATE TRIGGER fail_refresh BEFORE INSERT ON offer_observations WHEN NEW.external_id='second' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
  )
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    detailLimit: 2,
    adapters: [adapter],
  })
  runtimes.push(runtime)
  try {
    expect(await imported(runtime)).toMatchObject({
      state: 'partial',
      counts: { checked: 1, unchanged: 1, rejected: 0 },
      budget: { detailUsed: 2 },
      sources: [
        {
          state: 'partial',
          coverage: 'complete',
          error: { code: 'INTERNAL_ERROR' },
        },
      ],
    })
    expect(
      runtime
        .results({ area: initialArea, showUnavailable: true })
        .listings.find(
          (listing) => listing.sourceRefs[0].externalId === 'second',
        ),
    ).toEqual(saved)
  } finally {
    db.close()
  }
})

test.each([1, 2])(
  'a %s-attempt mixed job gives the carried refresh class its bounded turn',
  async (detailLimit) => {
    const path = join(directory, `tiny-${detailLimit}.sqlite`)
    const clock = testClock(0)
    const seed = new ImportRuntime(path, 0, { ...clock })
    await imported(seed)
    await seed.close()
    const known = { ...fixtures[0], salePriceJpy: 111 }
    const url = 'https://example.invalid/new'
    const adapter = syntheticAdapter(0, [
      known,
      {
        ...known,
        primarySourceUrl: url,
        sourceRefs: [{ ...known.sourceRefs[0], externalId: 'new', url }],
      },
    ])
    const runtime = new ImportRuntime(path, 0, {
      areaFreshnessMs: 0,
      detailFreshnessMs: 0,
      ...clock,
      detailLimit,
      adapters: [adapter],
    })
    runtimes.push(runtime)
    expect(await imported(runtime)).toMatchObject({
      state: detailLimit === 1 ? 'partial' : 'succeeded',
      budget: { detailUsed: detailLimit },
      counts: { updated: 1, added: detailLimit - 1 },
    })
  },
)

test.each([302, 304])(
  'a refresh HTTP %s attempt remains charged to refresh and leaves a new-offer slot',
  async (status) => {
    const path = join(directory, `attempt-${status}.sqlite`)
    const clock = testClock(0)
    const seed = new ImportRuntime(path, 0, { ...clock })
    await imported(seed)
    await seed.close()
    const known = fixtures[0]
    const url = 'https://example.invalid/new'
    const base = syntheticAdapter(0, [
      known,
      {
        ...known,
        primarySourceUrl: url,
        sourceRefs: [{ ...known.sourceRefs[0], externalId: 'new', url }],
      },
    ])
    const adapter = {
      ...base,
      async fetchDetail(
        candidate: Parameters<typeof base.fetchDetail>[0],
        context: Parameters<typeof base.fetchDetail>[1],
      ) {
        await context.request('detail', candidate.url, {
          headers: { 'if-none-match': '"synthetic-v1"' },
        })
        return {
          identity: { sourceId: 'fixture', externalId: candidate.externalId },
          url: candidate.url,
          fetchedAt: context.now(),
          payload: candidate,
          provenance: { fixture: 'Authored synthetic conditional attempt' },
        }
      },
    }
    let refreshAttempts = 0
    const runtime = new ImportRuntime(path, 0, {
      areaFreshnessMs: 0,
      detailFreshnessMs: 0,
      ...clock,
      detailLimit: 2,
      adapters: [adapter],
      transport: async (url, options) => {
        if (url.includes('/offers/')) {
          refreshAttempts++
          expect(options.headers).toEqual({ 'if-none-match': '"synthetic-v1"' })
          return {
            status,
            headers: { location: 'https://example.invalid/redirected' },
          }
        }
        return { status: 200 }
      },
    })
    runtimes.push(runtime)
    expect(await imported(runtime)).toMatchObject({
      state: 'partial',
      counts: { added: 1 },
      budget: { detailUsed: 2 },
    })
    expect(refreshAttempts).toBe(1)
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(2)
  },
)

test('unsupported geography cannot bypass the source gate through saved refresh work', async () => {
  const path = join(directory, 'unsupported-refresh.sqlite')
  const clock = testClock(0)
  const seed = new ImportRuntime(path, 0, { ...clock })
  await imported(seed)
  await seed.close()
  const base = syntheticAdapter(0)
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [
      {
        ...base,
        capabilities: { ...base.capabilities, geography: 'unsupported' },
      },
    ],
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'failed',
    budget: { discoveryUsed: 0, detailUsed: 0 },
    counts: { checked: 0 },
  })
})

test('a source that saves a new offer stays partial when its released refresh is rejected', async () => {
  const path = join(directory, 'new-then-rejected-refresh.sqlite')
  const clock = testClock(0)
  let refreshing = false
  const sources = ['first', 'second'].map((sourceId) => {
    const offer = (externalId: string) => {
      const url = `https://example.invalid/${sourceId}/${externalId}`
      return {
        ...fixtures[0],
        primarySourceUrl: url,
        sourceRefs: [
          { ...fixtures[0].sourceRefs[0], sourceId, externalId, url },
        ],
      }
    }
    const base = syntheticAdapter(0, [offer('old'), offer('new')])
    return {
      ...base,
      async discover(
        input: Parameters<typeof base.discover>[0],
        context: Parameters<typeof base.discover>[1],
      ) {
        const page = await base.discover(input, context)
        return {
          ...page,
          candidates: page.candidates.filter((candidate) =>
            refreshing
              ? sourceId === 'second' && candidate.externalId === 'new'
              : candidate.externalId === 'old',
          ),
        }
      },
      normalize(evidence: Parameters<typeof base.normalize>[0]) {
        return refreshing &&
          sourceId === 'second' &&
          evidence.identity.externalId === 'old'
          ? {
              kind: 'rejected' as const,
              error: {
                code: 'PARSE_ERROR',
                message: 'Synthetic rejected tail refresh',
                retryable: false,
              },
            }
          : base.normalize(evidence)
      },
    }
  })
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: sources,
  })
  await imported(seed)
  await seed.close()
  refreshing = true
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    detailLimit: 4,
    adapters: sources,
  })
  runtimes.push(runtime)
  const job = await imported(runtime)
  expect(job).toMatchObject({
    state: 'partial',
    counts: { added: 1, unchanged: 1, rejected: 1 },
    sources: [
      { sourceId: 'first', state: 'succeeded' },
      {
        sourceId: 'second',
        state: 'partial',
        coverage: 'complete',
        error: { code: 'PARSE_ERROR' },
      },
    ],
    reasons: ['PARSE_ERROR'],
  })
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toHaveLength(3)
})

test('oldest successful refresh compares timestamp instants across UTC offsets', async () => {
  const path = join(directory, 'offset-order.sqlite')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const offers = ['earlier', 'later'].map((externalId) => {
    const url = `https://example.invalid/${externalId}`
    return {
      ...fixtures[0],
      primarySourceUrl: url,
      sourceRefs: [{ ...fixtures[0].sourceRefs[0], externalId, url }],
    }
  })
  let refreshing = false
  const base = syntheticAdapter(0, offers)
  const adapter = {
    ...base,
    async discover(
      input: Parameters<typeof base.discover>[0],
      context: Parameters<typeof base.discover>[1],
    ) {
      const page = await base.discover(input, context)
      return refreshing ? { ...page, candidates: [] } : page
    },
    normalize(evidence: Parameters<typeof base.normalize>[0]) {
      const result = base.normalize(evidence)
      if (result.kind === 'accepted') {
        result.observation.sourceCheckedAt =
          evidence.identity.externalId === 'earlier'
            ? '2026-10-01T01:00:00+09:00'
            : '2026-09-30T20:00:00Z'
        if (refreshing) result.observation.fields.salePriceJpy = 555
      }
      return result
    },
  }
  const seed = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    adapters: [adapter],
  })
  await imported(seed)
  await seed.close()
  refreshing = true
  const runtime = new ImportRuntime(path, 0, {
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    ...clock,
    detailLimit: 1,
    adapters: [adapter],
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { updated: 1 },
    budget: { detailUsed: 1 },
  })
  expect(
    runtime
      .results({ area: initialArea, showUnavailable: true })
      .listings.filter((listing) => listing.salePriceJpy === 555)
      .map((listing) => listing.sourceRefs[0].externalId),
  ).toEqual(['earlier'])
})
