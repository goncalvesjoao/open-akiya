// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { testClock } from './test-clock'
import { wait } from './transport'
import { syntheticAdapter } from './adapter'
import { initialArea } from '../shared/geography'

const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
test('retries rate limits through counted, paced transport and honors Retry-After', async () => {
  const clock = testClock(0)
  const starts: number[] = []
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    transport: async () => {
      starts.push(clock.now())
      return starts.length === 1
        ? { status: 429, headers: { 'retry-after': '5' } }
        : { status: 200 }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'retry',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).state)
    .toBe('succeeded')
  expect(runtime.inspect(request.jobIds[0]).budget).toMatchObject({
    discoveryUsed: 2,
    detailUsed: 1,
  })
  expect(starts).toEqual([0, 5000, 7000])
})

test('keeps successful sources and empty discovery distinct from a failed source', async () => {
  const clock = testClock(0)
  const good = syntheticAdapter(0)
  const bad = {
    ...good,
    capabilities: { ...good.capabilities, sourceId: 'blocked' },
  }
  const runtime = new ImportRuntime(':memory:', 0, {
    adapters: [bad, good],
    ...clock,
    transport: async () => ({ status: 403 }),
  })
  // Only the first adapter is blocked; the second discovery is a genuine empty result.
  good.discover = async () => ({
    candidates: [],
    nextCursor: null,
    exhausted: true,
    limitation: null,
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'mixed',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'partial',
    coverage: { status: 'partial', lastSuccessfulCheckAt: null },
    sources: [
      { state: 'failed', error: { code: 'SOURCE_BLOCKED' } },
      { state: 'succeeded', coverage: 'complete' },
    ],
  })
})

test('exhausted discovery attempts retain committed listings without complete coverage', async () => {
  const clock = testClock(0)
  const base = syntheticAdapter(0)
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          const page = await base.discover(input, context)
          return {
            ...page,
            nextCursor: String(Number(input.cursor ?? 0) + 1),
            exhausted: false,
          }
        },
      },
    ],
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'budget',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'partial',
    counts: { added: 1, checked: 1 },
    budget: { discoveryUsed: 10, detailUsed: 1 },
    coverage: { status: 'partial', lastSuccessfulCheckAt: null },
    error: { code: 'BUDGET_EXHAUSTED' },
  })
  expect(
    runtime.results({ area: initialArea, showUnavailable: false }).listings,
  ).toHaveLength(1)
})

test('rejects off-host redirects before another attempt and bounds rate-limit retries', async () => {
  for (const status of [302, 429]) {
    const clock = testClock(0)
    let attempts = 0
    const runtime = new ImportRuntime(':memory:', 0, {
      ...clock,
      transport: async () => {
        attempts++
        return {
          status,
          headers: { location: 'https://private.invalid/secret' },
        }
      },
    })
    runtimes.push(runtime)
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: String(status),
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(request.jobIds[0])).toMatchObject({
      state: 'failed',
      error: { code: status === 302 ? 'INVALID_SOURCE_URL' : 'RATE_LIMITED' },
      budget: { discoveryUsed: status === 302 ? 1 : 3 },
    })
    expect(attempts).toBe(status === 302 ? 1 : 3)
  }
})

test('parser rejection cannot certify complete coverage or expose raw adapter errors', async () => {
  const clock = testClock(0)
  const base = syntheticAdapter(0)
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    adapters: [
      {
        ...base,
        normalize: () => ({
          kind: 'rejected',
          error: { code: 'PRIVATE', message: 'secret token', retryable: false },
        }),
      },
    ],
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'parser',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    coverage: { status: 'partial' },
    counts: { rejected: 1 },
    sources: [{ error: { code: 'PARSE_ERROR' } }],
  })
  expect(JSON.stringify(runtime.inspect(request.jobIds[0]))).not.toContain(
    'secret token',
  )
})

test('detail attempts stop at 100 and known-outside candidates consume no details', async () => {
  const clock = testClock(0)
  const base = syntheticAdapter(0)
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          const page = await base.discover(input, context)
          const candidate = page.candidates[0]
          return {
            ...page,
            candidates: [
              {
                ...candidate,
                externalId: 'outside',
                relevance: 'known_outside',
              },
              ...Array.from({ length: 101 }, (_, index) => ({
                ...candidate,
                externalId: `offer-${index}`,
              })),
            ],
          }
        },
      },
    ],
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'details',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage, { timeout: 5000 })
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'partial',
    counts: { discovered: 102, checked: 100, added: 100 },
    budget: { detailUsed: 100 },
    coverage: { status: 'partial' },
  })
})

test('timeouts have bounded retries and cancellation aborts transport without retrying', async () => {
  for (const cancel of [false, true]) {
    const clock = testClock(0)
    let attempts = 0
    let aborted = false
    const runtime = new ImportRuntime(':memory:', 0, {
      ...clock,
      requestTimeoutMs: 5,
      transport: async (_url, options) => {
        attempts++
        options.signal!.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true },
        )
        return new Promise(() => {})
      },
    })
    runtimes.push(runtime)
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: String(cancel),
    })
    if (cancel) {
      await expect.poll(() => attempts, { interval: 1 }).toBe(1)
      runtime.cancel(request.jobIds[0])
    }
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(request.jobIds[0])).toMatchObject(
      cancel
        ? { state: 'cancelled' }
        : { state: 'failed', error: { code: 'TIMEOUT' } },
    )
    expect(attempts).toBe(cancel ? 1 : 3)
    expect(aborted).toBe(true)
  }
})

test('serializes concurrent requests across sources and counts every allowed redirect hop', async () => {
  const clock = testClock(0)
  let active = 0
  let maximum = 0
  const starts: number[] = []
  const base = syntheticAdapter(0)
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    transport: async (url) => {
      active++
      maximum = Math.max(maximum, active)
      starts.push(clock.now())
      await Promise.resolve()
      active--
      return url.endsWith('/redirect')
        ? { status: 302, headers: { location: '/end' } }
        : { status: 200 }
    },
    adapters: [
      {
        ...base,
        async discover(_input, context) {
          await Promise.all([
            context.request('discovery', 'https://example.invalid/redirect'),
            context.request('discovery', 'https://example.invalid/other'),
          ])
          return {
            candidates: [],
            exhausted: true,
            nextCursor: null,
            limitation: null,
          }
        },
      },
    ],
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'parallel',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).state)
    .toBe('succeeded')
  expect(runtime.inspect(request.jobIds[0]).budget.discoveryUsed).toBe(3)
  expect(starts).toEqual([0, 2000, 4000])
  expect(maximum).toBe(1)
})

test('failed refresh preserves the previous listing and successful-check timestamp', async () => {
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  let blocked = false
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    transport: async () => ({ status: blocked ? 403 : 200 }),
  })
  runtimes.push(runtime)
  const input = { area: initialArea, intent: 'import', idempotencyKey: 'first' }
  const first = runtime.createRequest(input)
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).state)
    .toBe('succeeded')
  const saved = runtime.results({
    area: initialArea,
    showUnavailable: true,
  }).listings
  blocked = true
  clock.advance(100000)
  const second = runtime.createRequest({
    ...input,
    idempotencyKey: 'failed-refresh',
  })
  await expect
    .poll(() => runtime.inspect(second.jobIds[0]).state)
    .toBe('failed')
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toEqual(saved)
  expect(
    runtime.inspect(second.jobIds[0]).coverage.lastSuccessfulCheckAt,
  ).toBeNull()
  expect(
    runtime.inspect(first.jobIds[0]).coverage.lastSuccessfulCheckAt,
  ).not.toBeNull()
})

test('restart honors a durable retry deadline and retains scope evidence privately', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bounded-import-'))
  const path = join(directory, 'db.sqlite')
  let waiting = false
  const clock = testClock(0)
  const first = new ImportRuntime(path, 0, {
    ...clock,
    transport: async () => ({ status: 429, headers: { 'retry-after': '5' } }),
    wait: async (_ms, signal) => {
      signal.throwIfAborted()
      waiting = true
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      signal.throwIfAborted()
    },
  })
  let second: ImportRuntime | undefined
  try {
    const request = first.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'restart',
    })
    await expect.poll(() => waiting).toBe(true)
    await first.close()
    const saved = new DatabaseSync(path)
    expect(
      saved.prepare('SELECT retry_at FROM source_task_state').get()?.retry_at,
    ).toBe(5000)
    const frozen = JSON.parse(
      String(saved.prepare('SELECT scope FROM import_jobs_v2').get()?.scope),
    )
    expect(frozen).toMatchObject({
      area: initialArea,
      sources: [{ adapterVersion: 'synthetic-v1', cursorVersion: 'v1' }],
    })
    saved.close()
    const starts: number[] = []
    second = new ImportRuntime(path, 0, {
      ...clock,
      transport: async () => {
        starts.push(clock.now())
        return { status: 200 }
      },
    })
    const recovered = second
    await expect
      .poll(() => recovered.inspect(request.jobIds[0]).state)
      .toBe('succeeded')
    expect(starts).toEqual([5000, 7000])
    expect(recovered.inspect(request.jobIds[0]).budget.discoveryUsed).toBe(2)
    expect(JSON.stringify(recovered.inspect(request.jobIds[0]))).not.toContain(
      'retry_at',
    )
  } finally {
    await first.close()
    await second?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saved resumable discovery is useful partial progress even before the first detail commits', async () => {
  const clock = testClock(0)
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    transport: async (url) => ({
      status: url.includes('/offers/') ? 403 : 200,
    }),
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'resumable',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'partial',
    counts: { discovered: 1, added: 0, checked: 0 },
    sources: [
      {
        state: 'partial',
        coverage: 'partial',
        error: { code: 'SOURCE_BLOCKED' },
      },
    ],
  })
})

test('persists long and final Retry-After cooldowns across sources, jobs and restart', async () => {
  for (const finalAttempt of [false, true]) {
    for (const restart of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), 'host-cooldown-'))
      const path = join(directory, 'db.sqlite')
      const clock = testClock(0)
      const starts: number[] = []
      let attempts = 0
      const base = syntheticAdapter(0)
      const empty = {
        ...base,
        async discover(
          _input: unknown,
          context: Parameters<typeof base.discover>[1],
        ) {
          await context.request(
            'discovery',
            'https://example.invalid/discovery',
          )
          return {
            candidates: [],
            exhausted: true,
            nextCursor: null,
            limitation: null,
          }
        },
      }
      const other = {
        ...empty,
        capabilities: { ...empty.capabilities, sourceId: 'other' },
      }
      const adapters = restart ? [empty] : [empty, other]
      const transport = async () => {
        starts.push(clock.now())
        attempts++
        if (attempts <= (finalAttempt ? 3 : 1))
          return {
            status: finalAttempt ? 503 : 429,
            headers: {
              'retry-after': finalAttempt
                ? attempts < 3
                  ? '0'
                  : new Date(clock.now() + 3600000).toUTCString()
                : '3600',
            },
          }
        return { status: 200 }
      }
      let runtime = new ImportRuntime(path, 0, {
        ...clock,
        adapters,
        transport,
      })
      try {
        const request = runtime.createRequest({
          area: initialArea,
          intent: 'import',
          idempotencyKey: 'first',
        })
        await expect
          .poll(() => runtime.inspect(request.jobIds[0]).stage)
          .toBe('finished')
        const due = finalAttempt ? 3604000 : 3600000
        if (restart) {
          runtime.createRequest({
            area: initialArea,
            intent: 'import',
            idempotencyKey: 'next',
          })
          await runtime.close()
          const saved = new DatabaseSync(path)
          expect(
            saved.prepare('SELECT next_at FROM source_host_limits').get()
              ?.next_at,
          ).toBe(due)
          saved.close()
          runtime = new ImportRuntime(path, 0, {
            ...clock,
            adapters,
            transport,
          })
          await expect
            .poll(() => runtime.list({ state: 'active' }).jobs)
            .toHaveLength(0)
        }
        expect(starts).toEqual(finalAttempt ? [0, 2000, 4000, due] : [0, due])
      } finally {
        await runtime.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }
})

test('request cancellation interrupts Retry-After backoff without another transport attempt', async () => {
  const clock = testClock(0)
  let waiting = false
  let attempts = 0
  const runtime = new ImportRuntime(':memory:', 0, {
    ...clock,
    wait: async (milliseconds, signal) => {
      waiting = true
      await wait(milliseconds, signal)
      clock.advance(milliseconds)
    },
    transport: async () => {
      attempts++
      return { status: 429, headers: { 'retry-after': '5' } }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'cancel-backoff',
  })
  await expect.poll(() => waiting).toBe(true)
  expect(
    await runtime.dispatch('cancelImportRequest', request.id),
  ).toMatchObject({ state: 'cancelled' })
  await expect
    .poll(() => runtime.inspectRequest(request.id).state)
    .toBe('cancelled')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'cancelled',
    reasons: ['USER_CANCELLED'],
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(attempts).toBe(1)
  expect(await runtime.dispatch('cancelImportRequest', request.id)).toEqual(
    runtime.inspectRequest(request.id),
  )
})
