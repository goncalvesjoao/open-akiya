// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { LocalApiError } from './errors'
import { fixtures } from './fixtures'
import { syntheticAdapter } from './adapter'
import { testClock } from './test-clock'
import { initialArea } from '../shared/geography'

const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})

test('continues saved detail work once across requests and restart without mutating the original', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-'))
  const path = join(directory, 'db.sqlite')
  const base = syntheticAdapter(0)
  let discoveries = 0
  const requests: string[] = []
  const options = {
    ...testClock(0),
    detailLimit: 1,
    transport: async (url: string) => {
      requests.push(url)
      return { status: 200 }
    },
    adapters: [
      {
        ...base,
        async discover(
          input: Parameters<typeof base.discover>[0],
          context: Parameters<typeof base.discover>[1],
        ) {
          discoveries++
          const page = await base.discover(input, context)
          return {
            ...page,
            candidates: [
              page.candidates[0],
              { ...page.candidates[0], externalId: 'second' },
            ],
          }
        },
      },
    ],
  }
  let runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'first',
    })
    await expect
      .poll(() => runtime.inspect(first.jobIds[0]).stage)
      .toBe('finished')
    const original = runtime.inspect(first.jobIds[0])
    expect(original).toMatchObject({
      state: 'partial',
      continuation: { available: true },
    })
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.id,
      idempotencyKey: 'next',
    })
    expect(next).toMatchObject({
      intent: 'continue',
      disposition: 'continued',
      area: initialArea,
    })
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      counts: { checked: 0 },
      budget: { detailUsed: 0 },
      continuation: { fromJobId: original.id },
    })
    expect(
      runtime.createRequest({
        intent: 'continue',
        fromJobId: original.id,
        idempotencyKey: 'another-click',
      }).jobIds,
    ).toEqual(next.jobIds)
    await runtime.close()
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    expect(runtime.inspectRequest(next.id)).toEqual(next)
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).state)
      .toBe('succeeded')
    expect(runtime.inspect(first.jobIds[0])).toEqual(original)
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      counts: { checked: 1, added: 1 },
      budget: { discoveryUsed: 0, detailUsed: 1 },
      coverage: { status: 'complete' },
      continuation: { available: false },
    })
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(2)
    expect(discoveries).toBe(1)
    expect(requests).toHaveLength(3)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects active, complete and replacement-area continuations; cancelled queued work waits for user action', async () => {
  const runtime = new ImportRuntime(':memory:', 0, { ...testClock(0) })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'cancel',
  })
  const continuation = {
    intent: 'continue',
    fromJobId: first.jobIds[0],
    idempotencyKey: 'resume',
  }
  expect(() => runtime.createRequest(continuation)).toThrow(
    'Import is still active',
  )
  runtime.cancel(first.jobIds[0])
  const cancelled = runtime.inspect(first.jobIds[0])
  expect(cancelled).toMatchObject({
    state: 'cancelled',
    continuation: { available: true },
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
  expect(() =>
    runtime.createRequest({ ...continuation, area: initialArea }),
  ).toThrow('Continuation cannot replace')
  const resumed = runtime.createRequest(continuation)
  await expect
    .poll(() => runtime.inspect(resumed.jobIds[0]).state)
    .toBe('succeeded')
  expect(runtime.inspect(cancelled.id)).toEqual(cancelled)
  expect(() =>
    runtime.createRequest({
      ...continuation,
      fromJobId: resumed.jobIds[0],
      idempotencyKey: 'complete',
    }),
  ).toThrow('Import has no pending work')
  expect(() =>
    runtime.createRequest({ ...continuation, fromJobId: resumed.jobIds[0] }),
  ).toThrow('Idempotency key')
})

async function restartCursor(code: string) {
  const base = syntheticAdapter(0)
  let expired = false
  const runtime = new ImportRuntime(':memory:', 0, {
    ...testClock(0),
    discoveryLimit: 1,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          if (input.cursor && expired) {
            await context.request(
              'discovery',
              'https://example.invalid/expired',
            )
            throw new LocalApiError(409, code, 'Saved cursor expired')
          }
          const page = await base.discover(input, context)
          return {
            ...page,
            exhausted: expired,
            nextCursor: expired ? null : 'next',
          }
        },
      },
    ],
  })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'cursor',
  })
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).stage)
    .toBe('finished')
  expired = true
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: first.jobIds[0],
    idempotencyKey: 'cursor-next',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(next.jobIds[0])).toMatchObject({
    state: 'partial',
    budget: { discoveryUsed: 1 },
    continuation: {
      available: true,
      restarted: true,
      restartReason: code,
    },
  })
  const last = runtime.createRequest({
    intent: 'continue',
    fromJobId: next.jobIds[0],
    idempotencyKey: 'cursor-last',
  })
  await expect
    .poll(() => runtime.inspect(last.jobIds[0]).state)
    .toBe('succeeded')
  expect(runtime.inspect(last.jobIds[0])).toMatchObject({
    counts: { checked: 0 },
    coverage: { status: 'complete' },
    reasons: expect.arrayContaining([code]),
    continuation: { restarted: true, restartReason: code },
  })
  expect(runtime.inspect(last.jobIds[0]).coverage.caveats).toContain(
    'Saved cursor expired or invalid; discovery restarted within this job budget',
  )
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toHaveLength(1)
}
test.each(['CURSOR_EXPIRED', 'CURSOR_INVALID'])(
  'bounded cursor restart preserves explanation: %s',
  restartCursor,
)

test('continues failed sources and cancelled pending details while leaving completed sources alone', async () => {
  for (const cancel of [false, true]) {
    const clock = testClock(0)
    const base = syntheticAdapter(0)
    let blocked = true
    const starts: string[] = []
    const second = syntheticAdapter(0, [
      {
        ...fixtures[0],
        sourceRefs: [{ ...fixtures[0].sourceRefs[0], sourceId: 'second' }],
      },
    ])
    const runtime = new ImportRuntime(':memory:', 0, {
      ...clock,
      adapters: [base, second],
      transport: async (url) => {
        starts.push(url)
        if (blocked && starts.length === 3) return { status: 403 }
        return { status: 200 }
      },
    })
    runtimes.push(runtime)
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'mixed',
    })
    await expect
      .poll(() => runtime.inspect(first.jobIds[0]).stage)
      .toBe('finished')
    const original = runtime.inspect(first.jobIds[0])
    expect(original).toMatchObject({
      state: 'partial',
      sources: [{ state: 'succeeded' }, { state: 'failed' }],
      continuation: { available: true },
    })
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.id,
      idempotencyKey: 'mixed-next',
    })
    if (cancel) {
      runtime.cancel(next.jobIds[0])
      expect(runtime.inspect(next.jobIds[0])).toMatchObject({
        state: 'cancelled',
        continuation: { available: true },
      })
    }
    blocked = false
    const final = cancel
      ? runtime.createRequest({
          intent: 'continue',
          fromJobId: next.jobIds[0],
          idempotencyKey: 'mixed-final',
        })
      : next
    await expect
      .poll(() => runtime.inspect(final.jobIds[0]).state)
      .toBe('succeeded')
    expect(runtime.inspect(final.jobIds[0])).toMatchObject({
      budget: { discoveryUsed: 1, detailUsed: 1 },
    })
    expect(starts).toHaveLength(5)
    expect(runtime.inspect(original.id)).toEqual(original)
  }
})

test('two workers atomically reuse a terminal progress generation and update every linked request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-race-'))
  const path = join(directory, 'db.sqlite')
  const clock = testClock(0)
  const first = new ImportRuntime(path, 0, { ...clock })
  const second = new ImportRuntime(path, 0, { ...clock })
  runtimes.push(first, second)
  try {
    const original = first.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'race',
    })
    first.cancel(original.jobIds[0])
    const input = { intent: 'continue', fromJobId: original.jobIds[0] }
    const [left, right] = (await Promise.all([
      first.dispatch('createImportRequest', {
        ...input,
        idempotencyKey: 'left',
      }),
      second.dispatch('createImportRequest', {
        ...input,
        idempotencyKey: 'right',
      }),
    ])) as [
      import('../shared/desktop').ImportRequest,
      import('../shared/desktop').ImportRequest,
    ]
    expect(left.jobIds).toEqual(right.jobIds)
    expect(first.list({ state: 'active' }).jobs).toHaveLength(1)
    await expect
      .poll(() => second.inspectRequest(right.id).state)
      .toBe('succeeded')
    expect(first.inspectRequest(left.id).state).toBe('succeeded')
    expect(
      first.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(1)
  } finally {
    await first.close()
    await second.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

async function restartSemantics(change: string) {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-scope-'))
  const path = join(directory, 'db.sqlite')
  const base = syntheticAdapter(0)
  const clock = testClock(0)
  let runtime = new ImportRuntime(path, 0, { ...clock })
  runtimes.push(runtime)
  try {
    const original = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'scope',
    })
    runtime.cancel(original.jobIds[0])
    await runtime.close()
    runtime = new ImportRuntime(path, 0, { ...clock, adapters: [] })
    runtimes.push(runtime)
    const input = {
      intent: 'continue',
      fromJobId: original.jobIds[0],
      idempotencyKey: 'new-scope',
    }
    expect(() => runtime.createRequest(input)).toThrow(
      'Saved source configuration is unavailable',
    )
    await runtime.close()
    runtime = new ImportRuntime(path, 0, {
      ...clock,
      fixedFilters: change === 'filters' ? { residential: false } : undefined,
      referenceVersion: change === 'reference' ? 'reference-v2' : undefined,
      adapters: [
        {
          ...base,
          capabilities: {
            ...base.capabilities,
            adapterVersion:
              change === 'adapter'
                ? 'synthetic-v2'
                : base.capabilities.adapterVersion,
          },
        },
      ],
    })
    runtimes.push(runtime)
    const next = runtime.createRequest(input)
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      continuation: {
        restarted: true,
        restartReason: 'SOURCE_CONFIGURATION_CHANGED',
      },
      coverage: { status: 'partial' },
    })
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).state)
      .toBe('succeeded')
    expect(runtime.inspect(next.jobIds[0]).coverage.caveats).toContain(
      'Source configuration changed; discovery restarted with current semantics',
    )
    expect(runtime.inspect(next.jobIds[0]).scopeKey).not.toBe(
      runtime.inspect(original.jobIds[0]).scopeKey,
    )
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(1)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
test.each(['adapter', 'filters', 'reference'])(
  'changed semantics restart with explanation: %s',
  restartSemantics,
)

test('running cancellation after a committed detail preserves progress for explicit continuation', async () => {
  const base = syntheticAdapter(0)
  let waiting = false
  let block = true
  let attempts = 0
  const runtime = new ImportRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [
      {
        ...base,
        async discover(input, context) {
          const page = await base.discover(input, context)
          return {
            ...page,
            candidates: [
              page.candidates[0],
              { ...page.candidates[0], externalId: 'pending' },
            ],
          }
        },
      },
    ],
    transport: async (_url, options) => {
      attempts++
      if (block && attempts === 3) {
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
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'running-cancel',
  })
  await expect.poll(() => waiting).toBe(true)
  runtime.cancel(first.jobIds[0])
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).state)
    .toBe('cancelled')
  const original = runtime.inspect(first.jobIds[0])
  expect(original).toMatchObject({
    counts: { checked: 1, added: 1 },
    continuation: { available: true },
  })
  block = false
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: original.id,
    idempotencyKey: 'running-resume',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).state)
    .toBe('succeeded')
  expect(runtime.inspect(next.jobIds[0])).toMatchObject({
    counts: { checked: 1, added: 1 },
    budget: { discoveryUsed: 0, detailUsed: 1 },
  })
  expect(runtime.inspect(original.id)).toEqual(original)
  expect(attempts).toBe(4)
})

test('interrupted continuation recovers the same request and does not replay committed details', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-interrupted-'))
  const path = join(directory, 'db.sqlite')
  const base = syntheticAdapter(0)
  const clock = testClock(0)
  const adapter = {
    ...base,
    async discover(
      input: Parameters<typeof base.discover>[0],
      context: Parameters<typeof base.discover>[1],
    ) {
      const page = await base.discover(input, context)
      return {
        ...page,
        candidates: Array.from({ length: 4 }, (_, index) => ({
          ...page.candidates[0],
          externalId: `offer-${index}`,
        })),
      }
    },
  }
  let attempts = 0
  let waiting = false
  let block = true
  const transport = async (_url: string, options: RequestInit) => {
    attempts++
    if (block && attempts === 5) {
      waiting = true
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      )
      options.signal!.throwIfAborted()
    }
    return { status: 200 }
  }
  let runtime = new ImportRuntime(path, 0, {
    ...clock,
    adapters: [adapter],
    detailLimit: 2,
    transport,
  })
  runtimes.push(runtime)
  try {
    const original = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'interrupt-first',
    })
    await expect
      .poll(() => runtime.inspect(original.jobIds[0]).stage)
      .toBe('finished')
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.jobIds[0],
      idempotencyKey: 'interrupt-next',
    })
    await expect.poll(() => waiting).toBe(true)
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      counts: { checked: 1, added: 1 },
    })
    await runtime.close()
    block = false
    runtime = new ImportRuntime(path, 0, {
      ...clock,
      adapters: [adapter],
      detailLimit: 3,
      transport,
    })
    runtimes.push(runtime)
    await expect
      .poll(() => runtime.inspectRequest(next.id).state)
      .toBe('partial')
    // The aborted attempt used the saved two-request budget. A new explicit job
    // receives another budget; recovery cannot silently increase the old one.
    const last = runtime.createRequest({
      intent: 'continue',
      fromJobId: next.jobIds[0],
      idempotencyKey: 'interrupt-final',
    })
    await expect
      .poll(() => runtime.inspect(last.jobIds[0]).state)
      .toBe('succeeded')
    expect(runtime.inspect(last.jobIds[0])).toMatchObject({
      counts: { checked: 1, added: 1 },
      budget: { discoveryUsed: 0, detailUsed: 1 },
    })
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(4)
    expect(attempts).toBe(6)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('failed discovery advertises restartable work without automatically creating another job', async () => {
  let blocked = true
  const runtime = new ImportRuntime(':memory:', 0, {
    ...testClock(0),
    transport: async () => ({ status: blocked ? 403 : 200 }),
  })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'failed',
  })
  await expect.poll(() => runtime.inspect(first.jobIds[0]).state).toBe('failed')
  const failed = runtime.inspect(first.jobIds[0])
  expect(failed).toMatchObject({
    counts: { added: 0 },
    continuation: { available: true },
    coverage: { lastSuccessfulCheckAt: null },
  })
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
  blocked = false
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: failed.id,
    idempotencyKey: 'failed-next',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).state)
    .toBe('succeeded')
  expect(runtime.inspect(failed.id)).toEqual(failed)
})

test.each(['normalization', 'validation'] as const)(
  'a continuation cannot erase an earlier %s rejection when later details succeed',
  async (failure) => {
    const base = syntheticAdapter(0)
    let checks = 0
    const runtime = new ImportRuntime(':memory:', 0, {
      ...testClock(0),
      detailLimit: 1,
      adapters: [
        {
          ...base,
          async discover(input, context) {
            const page = await base.discover(input, context)
            return {
              ...page,
              candidates: [
                page.candidates[0],
                { ...page.candidates[0], externalId: 'later' },
              ],
            }
          },
          normalize(evidence) {
            checks++
            if (checks === 1 && failure === 'normalization')
              return {
                kind: 'rejected',
                error: {
                  code: 'PARSE_ERROR',
                  message: 'Synthetic rejection',
                  retryable: false,
                },
              }
            const normalized = base.normalize(evidence)
            if (checks === 1 && normalized.kind === 'accepted')
              normalized.observation.fields.salePriceJpy = -1
            return normalized
          },
        },
      ],
    })
    runtimes.push(runtime)
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'rejected-first',
    })
    await expect
      .poll(() => runtime.inspect(first.jobIds[0]).stage)
      .toBe('finished')
    const original = runtime.inspect(first.jobIds[0])
    expect(original).toMatchObject({
      counts: { rejected: 1, added: 0 },
      continuation: { available: true },
    })
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.id,
      idempotencyKey: 'after-rejection',
    })
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      state: 'partial',
      counts: { checked: 1, added: 1, rejected: 0 },
      coverage: { status: 'partial', lastSuccessfulCheckAt: null },
      sources: [
        {
          coverage: 'partial',
          error: {
            code:
              failure === 'normalization' ? 'PARSE_ERROR' : 'INVALID_REQUEST',
          },
        },
      ],
      continuation: { available: false },
    })
    expect(runtime.inspect(original.id)).toEqual(original)
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(1)
  },
)

test('bounded generations alternate detail classes and retain the oldest omitted refresh tasks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-fair-'))
  const path = join(directory, 'db.sqlite')
  const clock = testClock(0)
  const offer = (externalId: string) => ({
    ...fixtures[0],
    id: externalId,
    sourceRefs: [
      {
        ...fixtures[0].sourceRefs[0],
        externalId,
        url: `https://example.invalid/${externalId}`,
      },
    ],
    primarySourceUrl: `https://example.invalid/${externalId}`,
  })
  const known = ['old-a', 'old-b', 'old-c'].map(offer)
  const seed = new ImportRuntime(path, 0, {
    ...clock,
    adapters: [syntheticAdapter(0, known)],
  })
  const seeded = seed.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'seed',
  })
  await expect.poll(() => seed.inspect(seeded.jobIds[0]).stage).toBe('finished')
  await seed.close()
  const base = syntheticAdapter(0, [
    ...known,
    ...['new-a', 'new-b', 'new-c'].map(offer),
  ])
  const checked: string[] = []
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    detailLimit: 1,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          const page = await base.discover(input, context)
          return {
            ...page,
            candidates: page.candidates.filter((candidate) =>
              candidate.externalId.startsWith('new-'),
            ),
          }
        },
      },
    ],
    transport: async (url) => {
      if (!url.includes('/discovery')) checked.push(url.split('/').at(-1)!)
      return { status: 200 }
    },
  })
  runtimes.push(runtime)
  try {
    let request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'mixed',
    })
    for (let i = 0; i < 6; i++) {
      await expect
        .poll(() => runtime.inspect(request.jobIds[0]).stage)
        .toBe('finished')
      const job = runtime.inspect(request.jobIds[0])
      expect(job.budget.detailUsed).toBe(1)
      if (i < 5) {
        expect(job.continuation.available).toBe(true)
        request = runtime.createRequest({
          intent: 'continue',
          fromJobId: job.id,
          idempotencyKey: `next-${i}`,
        })
      } else
        expect(job).toMatchObject({
          state: 'succeeded',
          continuation: { available: false },
        })
    }
    expect(checked).toEqual([
      'old-a',
      'new-a',
      'old-b',
      'new-b',
      'old-c',
      'new-c',
    ])
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('refresh rejection evidence belongs to its source while refresh-only work continues', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-refresh-'))
  const path = join(directory, 'db.sqlite')
  const clock = testClock(0)
  const adapters = ['first', 'second'].map((sourceId) =>
    syntheticAdapter(0, [
      {
        ...fixtures[0],
        sourceRefs: [{ ...fixtures[0].sourceRefs[0], sourceId }],
      },
    ]),
  )
  const seed = new ImportRuntime(path, 0, { ...clock, adapters })
  const seeded = seed.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'seed',
  })
  await expect.poll(() => seed.inspect(seeded.jobIds[0]).stage).toBe('finished')
  await seed.close()
  let discoveries = 0
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    adapters: adapters.map((base) => ({
      ...base,
      async discover(input, context) {
        discoveries++
        const page = await base.discover(input, context)
        return { ...page, candidates: [] }
      },
      normalize(evidence) {
        return base.capabilities.sourceId === 'second'
          ? {
              kind: 'rejected' as const,
              error: {
                code: 'PARSE_ERROR' as const,
                message: 'Rejected refresh',
                retryable: false,
              },
            }
          : base.normalize(evidence)
      },
    })),
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    detailLimit: 1,
  })
  runtimes.push(runtime)
  try {
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'refresh',
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    const original = runtime.inspect(request.jobIds[0])
    expect(original.continuation.available).toBe(true)
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.id,
      idempotencyKey: 'continue-refresh',
    })
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      budget: { discoveryUsed: 0, detailUsed: 1 },
      counts: { rejected: 1 },
      continuation: { available: false },
      sources: [
        { sourceId: 'first', state: 'succeeded', error: null },
        { sourceId: 'second', error: { code: 'PARSE_ERROR' } },
      ],
    })
    expect(discoveries).toBe(2)
    expect(runtime.inspect(original.id)).toEqual(original)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

async function recheckChangedSemantics(change: string) {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-version-'))
  const path = join(directory, 'db.sqlite')
  const clock = testClock(0)
  const offers = ['first', 'second'].map((externalId) => ({
    ...fixtures[0],
    sourceRefs: [
      {
        ...fixtures[0].sourceRefs[0],
        externalId,
        url: `https://example.invalid/${externalId}`,
      },
    ],
    primarySourceUrl: `https://example.invalid/${externalId}`,
  }))
  const base = syntheticAdapter(0, offers)
  const first = new ImportRuntime(path, 0, {
    ...clock,
    detailLimit: 1,
    adapters: [base],
  })
  const request = first.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'initial',
  })
  await expect
    .poll(() => first.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  await first.close()
  const changed = {
    ...base,
    capabilities: {
      ...base.capabilities,
      adapterVersion:
        change === 'adapter' ? 'v2' : base.capabilities.adapterVersion,
    },
  }
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    adapters: [changed],
    fixedFilters: change === 'filters' ? { residential: false } : undefined,
    referenceVersion: change === 'reference' ? 'reference-v2' : undefined,
  })
  runtimes.push(runtime)
  try {
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: request.jobIds[0],
      idempotencyKey: 'version',
    })
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      state: 'succeeded',
      counts: { checked: 2, added: 1 },
      budget: { detailUsed: 2 },
    })
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(2)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
test.each(['adapter', 'filters', 'reference'])(
  'changed semantics recheck saved offers: %s',
  recheckChangedSemantics,
)

test('cancellation during tail refresh retains only unfinished tasks after discovery succeeds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'continuation-tail-'))
  const path = join(directory, 'db.sqlite')
  const clock = testClock(0)
  const offers = ['old-a', 'old-b', 'old-c'].map((externalId) => ({
    ...fixtures[0],
    sourceRefs: [
      {
        ...fixtures[0].sourceRefs[0],
        externalId,
        url: `https://example.invalid/${externalId}`,
      },
    ],
    primarySourceUrl: `https://example.invalid/${externalId}`,
  }))
  const base = syntheticAdapter(0, offers)
  const seed = new ImportRuntime(path, 0, { ...clock, adapters: [base] })
  const seeded = seed.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'seed',
  })
  await expect.poll(() => seed.inspect(seeded.jobIds[0]).stage).toBe('finished')
  await seed.close()
  let discoveries = 0
  let waiting = false
  let block = true
  const attempts: string[] = []
  const runtime = new ImportRuntime(path, 0, {
    ...clock,
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    detailLimit: 4,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          discoveries++
          return { ...(await base.discover(input, context)), candidates: [] }
        },
      },
    ],
    transport: async (url, options) => {
      if (url.includes('/old-')) attempts.push(url.split('/').at(-1)!)
      if (block && url.endsWith('/old-c')) {
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
  runtimes.push(runtime)
  try {
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'refresh',
    })
    await expect.poll(() => waiting).toBe(true)
    expect(runtime.inspect(request.jobIds[0]).sources[0].state).toBe(
      'succeeded',
    )
    runtime.cancel(request.jobIds[0])
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).state)
      .toBe('cancelled')
    const original = runtime.inspect(request.jobIds[0])
    expect(original).toMatchObject({
      continuation: { available: true },
      counts: { checked: 2 },
    })
    block = false
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.id,
      idempotencyKey: 'resume-tail',
    })
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      state: 'succeeded',
      continuation: { available: false },
      counts: { checked: 1 },
      budget: { discoveryUsed: 0, detailUsed: 1 },
    })
    expect(discoveries).toBe(1)
    expect(attempts).toEqual(['old-a', 'old-b', 'old-c', 'old-c'])
    expect(runtime.inspect(original.id)).toEqual(original)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each([false, true])(
  'cursor restart retains deferred stale refreshes (%s), host pacing and persisted successful explanation',
  async (stale) => {
    const directory = mkdtempSync(join(tmpdir(), 'cursor-intent-'))
    const path = join(directory, 'db.sqlite')
    const clock = testClock(0)
    const offers = ['known-a', 'known-b', 'new'].map((externalId) => ({
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
    const seed = syntheticAdapter(0, offers.slice(0, 2))
    let runtime = new ImportRuntime(path, 0, { ...clock, adapters: [seed] })
    runtimes.push(runtime)
    try {
      const seeded = runtime.createRequest({
        area: initialArea,
        intent: 'import',
        idempotencyKey: 'seed-intent',
      })
      await expect
        .poll(() => runtime.inspect(seeded.jobIds[0]).stage)
        .toBe('finished')
      const saved = runtime.results({
        area: initialArea,
        showUnavailable: true,
      }).listings
      await runtime.close()
      let replacement = false
      const base = syntheticAdapter(0, offers)
      const attempts: { url: string; at: number }[] = []
      const options = {
        ...clock,
        areaFreshnessMs: 0,
        detailFreshnessMs: stale ? 0 : 86400000,
        transport: async (url: string) => {
          attempts.push({ url, at: clock.now() })
          return { status: 200 }
        },
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
                  'CURSOR_INVALID',
                  'Synthetic invalid cursor',
                )
              }
              const page = await base.discover(input, context)
              return replacement
                ? page
                : {
                    ...page,
                    candidates: page.candidates.slice(0, 1),
                    nextCursor: 'saved',
                    exhausted: false,
                  }
            },
          },
        ],
      }
      runtime = new ImportRuntime(path, 0, {
        ...options,
        discoveryLimit: 1,
        detailLimit: 1,
      })
      runtimes.push(runtime)
      const first = runtime.createRequest({
        area: initialArea,
        intent: 'import',
        idempotencyKey: 'first-intent',
      })
      await expect
        .poll(() => runtime.inspect(first.jobIds[0]).stage)
        .toBe('finished')
      expect(runtime.inspect(first.jobIds[0]).state).toBe('partial')
      await runtime.close()
      replacement = true
      attempts.length = 0
      runtime = new ImportRuntime(path, 0, { ...options, discoveryLimit: 3 })
      runtimes.push(runtime)
      const continued = runtime.createRequest({
        intent: 'continue',
        fromJobId: first.jobIds[0],
        idempotencyKey: 'continued-intent',
      })
      await expect
        .poll(() => runtime.inspect(continued.jobIds[0]).stage)
        .toBe('finished')
      const job = runtime.inspect(continued.jobIds[0])
      expect(job).toMatchObject({
        state: 'succeeded',
        budget: { discoveryUsed: 2, detailUsed: stale ? 2 : 1 },
        counts: { added: 1 },
        coverage: { status: 'complete' },
        reasons: ['CURSOR_INVALID'],
        continuation: {
          available: false,
          restarted: true,
          restartReason: 'CURSOR_INVALID',
        },
      })
      expect(attempts).toHaveLength(stale ? 4 : 3)
      for (let index = 1; index < attempts.length; index++)
        expect(
          attempts[index].at - attempts[index - 1].at,
        ).toBeGreaterThanOrEqual(2000)
      const results = runtime.results({
        area: initialArea,
        showUnavailable: true,
      }).listings
      expect(results).toHaveLength(3)
      for (const offer of saved) {
        const result = results.find((listing) => listing.id === offer.id)!
        if (stale)
          expect(Date.parse(result.sourceCheckedAt!)).toBeGreaterThan(
            Date.parse(offer.sourceCheckedAt!),
          )
        else expect(result.sourceCheckedAt).toBe(offer.sourceCheckedAt)
      }
      await runtime.close()
      runtime = new ImportRuntime(path, 0, options)
      runtimes.push(runtime)
      expect(runtime.inspect(continued.jobIds[0])).toEqual(job)
      expect(runtime.inspectRequest(continued.id)).toMatchObject({
        state: 'succeeded',
        pendingFollowUp: false,
      })
    } finally {
      await runtime.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
