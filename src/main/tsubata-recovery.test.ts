import { afterEach, expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { testClock } from './test-clock'
import { tsubataAdapter } from './tsubata'
import { initialArea } from '../shared/geography'

const runtimes: ImportRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
})
const header =
  '全国地方公共団体コード,ID,契約形態,金額,受付状況,構造,備考,所在地_都道府県,所在地_町字\n'
const row = (id: string) =>
  `173614,TBB${id},売買,100,受付中,木造住宅,,石川県,字試験${id}\n`
const csv = header + row('000000001')
function adapter() {
  return tsubataAdapter({
    geographyVersion: 'synthetic-fixture-only',
    intersectsMunicipality: () => true,
  })
}
function openRuntime(
  path: string,
  delay: number,
  options: ConstructorParameters<typeof ImportRuntime>[2],
) {
  return new ImportRuntime(path, delay, {
    municipalityReference: (id) =>
      id === '173614'
        ? { representativePoint: null, representativePointProvenance: null }
        : undefined,
    ...options,
  })
}
test('a shared permitted export supplies successful offer checks without fictional detail requests', async () => {
  const requests: string[] = []
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async (url) => {
      requests.push(url)
      return { status: 200, body: csv }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'first',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'succeeded',
    counts: { added: 1, checked: 1 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(runtime.inspect(request.jobIds[0]).coverage.caveats).toContain(
    'Coverage is the published municipal export, not complete vacant-home inventory; live activation remains gated',
  )
  expect(requests).toEqual([
    'https://www.town.tsubata.lg.jp/division/file/opendata/173614_empty_bank.csv',
  ])
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toHaveLength(1)
})

test('bounded processing continues the same fully acquired snapshot after restart without more HTTP', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'tsubata-snapshot-'))
  const path = join(directory, 'db.sqlite')
  const requests: string[] = []
  const options = {
    ...testClock(0),
    rowLimit: 1,
    adapters: [adapter()],
    transport: async (url: string) => {
      requests.push(url)
      return { status: 200, body: csv + row('000000002') }
    },
  }
  let runtime = openRuntime(path, 0, options)
  runtimes.push(runtime)
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'bounded',
    })
    await expect
      .poll(() => runtime.inspect(first.jobIds[0]).stage)
      .toBe('finished')
    const original = runtime.inspect(first.jobIds[0])
    expect(original).toMatchObject({
      state: 'partial',
      counts: { added: 1 },
      continuation: { available: true },
      coverage: { lastSuccessfulCheckAt: null },
    })
    await runtime.close()
    runtime = openRuntime(path, 0, options)
    runtimes.push(runtime)
    const next = runtime.createRequest({
      intent: 'continue',
      fromJobId: original.id,
      idempotencyKey: 'next',
    })
    await expect
      .poll(() => runtime.inspect(next.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({
      state: 'succeeded',
      counts: { added: 1, checked: 1 },
      budget: { discoveryUsed: 0, detailUsed: 0 },
    })
    expect(runtime.inspect(original.id)).toEqual(original)
    expect(requests).toHaveLength(1)
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(2)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('truncated HTTP acquisition cannot certify coverage or retain a reusable snapshot', async () => {
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async () => {
      attempts++
      return { status: 200, headers: { 'Content-Length': '999' }, body: csv }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'truncated',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    counts: { added: 0 },
    error: { code: 'TRUNCATED_RESPONSE' },
    coverage: { lastSuccessfulCheckAt: null },
  })
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: request.jobIds[0],
    idempotencyKey: 'retry',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).stage)
    .toBe('finished')
  expect(attempts).toBe(2)
})

test('an isolated invalid row preserves valid offers and truthful rejected counts without complete coverage', async () => {
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async () => ({
      status: 200,
      body: csv + row('000000002').trimEnd() + ',unexpected\n',
    }),
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'invalid-row',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'partial',
    counts: { added: 1, rejected: 1 },
    coverage: { lastSuccessfulCheckAt: null },
    sources: [{ coverage: 'partial' }],
  })
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings,
  ).toHaveLength(1)
})

test('HTML challenges stop access without retries or endpoint fallback', async () => {
  const requests: string[] = []
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async (url) => {
      requests.push(url)
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html>Verify you are human: CAPTCHA</html>',
      }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'challenge',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    error: { code: 'SOURCE_BLOCKED' },
    budget: { discoveryUsed: 1 },
  })
  expect(requests).toHaveLength(1)
})

test('total physical response bytes include failed retries and stop before another request exceeds the budget', async () => {
  const attempts: number[] = []
  const clock = testClock(0)
  const runtime = openRuntime(':memory:', 0, {
    ...clock,
    byteLimit: 10,
    adapters: [adapter()],
    transport: async () => {
      attempts.push(clock.now())
      return { status: 503, body: '123456' }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'bytes',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    error: { code: 'BYTE_BUDGET_EXHAUSTED' },
    budget: { discoveryUsed: 2, byteUsed: 12, byteLimit: 10 },
  })
  expect(attempts).toEqual([0, 10000])
})

test('a stale processing snapshot restarts against a fresh fingerprint inside the continuation budget', async () => {
  const clock = testClock(0)
  let replacement = false
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...clock,
    rowLimit: 1,
    adapters: [adapter()],
    transport: async () => {
      attempts++
      return {
        status: 200,
        body: replacement ? csv + row('000000003') : csv + row('000000002'),
      }
    },
  })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'old-snapshot',
  })
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).stage)
    .toBe('finished')
  clock.advance(86400001)
  replacement = true
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: first.jobIds[0],
    idempotencyKey: 'changed-snapshot',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(next.jobIds[0])).toMatchObject({
    state: 'partial',
    continuation: { restarted: true, restartReason: 'SNAPSHOT_INVALID' },
    budget: { discoveryUsed: 1 },
    coverage: { lastSuccessfulCheckAt: null },
  })
  expect(attempts).toBe(2)
  expect(
    runtime
      .results({ area: initialArea, showUnavailable: true })
      .listings.map((listing) => listing.sourceRefs[0].externalId),
  ).not.toContain('173614:TBB000000002')
})

test('a redirect cannot widen the permitted CSV transport to a town asset', async () => {
  const requests: string[] = []
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async (url) => {
      requests.push(url)
      return requests.length === 1
        ? {
            status: 302,
            headers: { location: '/uploaded/attachment/asset.pdf' },
          }
        : { status: 200, body: csv }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'asset',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    error: { code: 'INVALID_SOURCE_URL' },
    budget: { discoveryUsed: 1 },
  })
  expect(requests).toHaveLength(1)
})

test('cancels during CSV processing, retains committed offers, and continues only on explicit action', async () => {
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async () => {
      attempts++
      return { status: 200, body: csv + row('000000002') + row('000000003') }
    },
  })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'cancel',
  })
  const id = first.jobIds[0]
  for (
    const deadline = Date.now() + 3000;
    Date.now() < deadline && runtime.inspect(id).counts.added === 0;
  )
    await new Promise<void>((resolve) => setImmediate(resolve))
  runtime.cancel(id)
  await expect.poll(() => runtime.inspect(id).stage).toBe('finished')
  const original = runtime.inspect(id)
  expect(original).toMatchObject({
    state: 'cancelled',
    counts: { added: 1 },
    coverage: { lastSuccessfulCheckAt: null },
  })
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: id,
    idempotencyKey: 'explicit',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(next.jobIds[0])).toMatchObject({
    state: 'succeeded',
    counts: { added: 2 },
    budget: { discoveryUsed: 0, detailUsed: 0 },
  })
  expect(runtime.inspect(id)).toEqual(original)
  expect(attempts).toBe(1)
})

test('fresh covering work is cached for 24 hours; stale and manual checks reacquire one shared export', async () => {
  const clock = testClock(0)
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...clock,
    adapters: [adapter()],
    transport: async () => {
      attempts++
      return { status: 200, body: csv + row('000000002') }
    },
  })
  runtimes.push(runtime)
  const run = async (
    key: string,
    intent: 'import' | 'manual_refresh' = 'import',
  ) => {
    const request = runtime.createRequest({
      area: initialArea,
      intent,
      idempotencyKey: key,
    })
    await expect
      .poll(() => runtime.inspectRequest(request.id).state)
      .toBe('succeeded')
    return runtime.inspectRequest(request.id)
  }
  await run('seed')
  expect(attempts).toBe(1)
  expect((await run('cache')).disposition).toBe('cached')
  clock.advance(86400001)
  const stale = await run('stale')
  expect(runtime.inspect(stale.jobIds[0])).toMatchObject({
    counts: { checked: 2, unchanged: 2 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(attempts).toBe(2)
  clock.advance(1000)
  const manual = await run('manual', 'manual_refresh')
  expect(runtime.inspect(manual.jobIds[0])).toMatchObject({
    counts: { checked: 2 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(attempts).toBe(3)
})

test('manual processing continuation reuses a snapshot acquired after its cutoff', async () => {
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    rowLimit: 1,
    adapters: [adapter()],
    transport: async () => {
      attempts++
      return { status: 200, body: csv + row('000000002') }
    },
  })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'manual-bounded',
  })
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspectRequest(first.id)).toMatchObject({
    state: 'partial',
    pendingFollowUp: false,
  })
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: first.jobIds[0],
    idempotencyKey: 'continue-manual',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(next.jobIds[0])).toMatchObject({
    state: 'succeeded',
    counts: { checked: 1, added: 1 },
    budget: { discoveryUsed: 0 },
  })
  expect(attempts).toBe(1)
})

test('attached manual intent retains a pending fresh follow-up when the original export predates its cutoff', async () => {
  const clock = testClock(0)
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...clock,
    adapters: [adapter()],
    transport: async () => {
      attempts++
      return { status: 200, body: csv + row('000000002') + row('000000003') }
    },
  })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'attach-first',
  })
  const id = first.jobIds[0]
  for (
    const deadline = Date.now() + 3000;
    Date.now() < deadline && runtime.inspect(id).counts.added === 0;
  )
    await new Promise<void>((resolve) => setImmediate(resolve))
  clock.advance(1000)
  const manual = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: 'attach-manual',
  })
  expect(manual).toMatchObject({
    disposition: 'attached',
    pendingFollowUp: true,
  })
  await expect
    .poll(() => runtime.inspectRequest(manual.id).state)
    .toBe('succeeded')
  const done = runtime.inspectRequest(manual.id)
  expect(done).toMatchObject({ pendingFollowUp: false })
  expect(done.jobIds).toHaveLength(2)
  expect(runtime.inspect(done.jobIds[1])).toMatchObject({
    counts: { checked: 3 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(attempts).toBe(2)
})

test.each(['adapter', 'query', 'reference'] as const)(
  'changed %s versions invalidate private snapshots and recheck required saved identities',
  async (change) => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'tsubata-versions-'))
    const path = join(directory, 'db.sqlite')
    const clock = testClock(0)
    let attempts = 0
    const transport = async () => {
      attempts++
      return { status: 200, body: csv + row('000000002') }
    }
    let runtime = openRuntime(path, 0, {
      ...clock,
      rowLimit: 1,
      adapters: [adapter()],
      transport,
    })
    runtimes.push(runtime)
    try {
      const first = runtime.createRequest({
        area: initialArea,
        intent: 'import',
        idempotencyKey: 'version-first',
      })
      await expect
        .poll(() => runtime.inspect(first.jobIds[0]).stage)
        .toBe('finished')
      await runtime.close()
      const changed = adapter()
      if (change === 'adapter')
        changed.capabilities.adapterVersion = 'parser-v2'
      if (change === 'query') changed.capabilities.queryVersion = 'query-v2'
      runtime = openRuntime(path, 0, {
        ...clock,
        adapters: [changed],
        referenceVersion: change === 'reference' ? 'reference-v2' : undefined,
        transport,
      })
      runtimes.push(runtime)
      const next = runtime.createRequest({
        intent: 'continue',
        fromJobId: first.jobIds[0],
        idempotencyKey: 'version-next',
      })
      await expect
        .poll(() => runtime.inspect(next.jobIds[0]).stage)
        .toBe('finished')
      expect(runtime.inspect(next.jobIds[0])).toMatchObject({
        state: 'succeeded',
        counts: { checked: 2, added: 1 },
        budget: { discoveryUsed: 1, detailUsed: 0 },
        continuation: { restarted: true },
      })
      expect(attempts).toBe(2)
      expect(
        runtime.results({ area: initialArea, showUnavailable: true }).listings,
      ).toHaveLength(2)
    } finally {
      await runtime.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test('oversize permitted export is classified separately from parser failure', async () => {
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async () => ({ status: 200, body: 'x'.repeat(262145) }),
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'oversize',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    error: { code: 'RESPONSE_TOO_LARGE' },
    coverage: { lastSuccessfulCheckAt: null },
  })
})

test.each([401, 403])(
  'HTTP %s stops after one physical request',
  async (status) => {
    let attempts = 0
    const runtime = openRuntime(':memory:', 0, {
      ...testClock(0),
      adapters: [adapter()],
      transport: async () => {
        attempts++
        return { status, body: 'blocked' }
      },
    })
    runtimes.push(runtime)
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: `blocked-${status}`,
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    expect(runtime.inspect(request.jobIds[0])).toMatchObject({
      state: 'failed',
      error: { code: 'SOURCE_BLOCKED' },
      budget: { discoveryUsed: 1 },
    })
    expect(attempts).toBe(1)
  },
)

test('Retry-After and the town pacing policy apply to actual attempts under a total request budget', async () => {
  const clock = testClock(0)
  const attempts: number[] = []
  const runtime = openRuntime(':memory:', 0, {
    ...clock,
    discoveryLimit: 2,
    adapters: [adapter()],
    transport: async () => {
      attempts.push(clock.now())
      return { status: 429, headers: { 'Retry-After': '11' }, body: '' }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'retry-after',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    error: { code: 'BUDGET_EXHAUSTED' },
    budget: { discoveryUsed: 2 },
    coverage: { lastSuccessfulCheckAt: null },
  })
  expect(attempts).toEqual([0, 11000])
})

test('the request deadline covers a stalled response stream and bounds retries', async () => {
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    requestTimeoutMs: 5,
    adapters: [adapter()],
    transport: async (_url, options) => {
      attempts++
      return {
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(header)
          await new Promise<void>((resolve) =>
            options.signal!.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          )
          options.signal!.throwIfAborted()
        })(),
      }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'stalled-stream',
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'failed',
    error: { code: 'TIMEOUT' },
    budget: { discoveryUsed: 3 },
    counts: { added: 0 },
  })
  expect(attempts).toBe(3)
})

test('cancelling incomplete acquisition saves no snapshot and explicit continuation performs one explained fresh request', async () => {
  let started = false
  let attempts = 0
  const runtime = openRuntime(':memory:', 0, {
    ...testClock(0),
    adapters: [adapter()],
    transport: async (_url, options) => {
      attempts++
      return attempts === 1
        ? {
            status: 200,
            body: (async function* () {
              yield new TextEncoder().encode(header)
              started = true
              await new Promise<void>((resolve) =>
                options.signal!.addEventListener('abort', () => resolve(), {
                  once: true,
                }),
              )
              options.signal!.throwIfAborted()
            })(),
          }
        : { status: 200, body: csv }
    },
  })
  runtimes.push(runtime)
  const first = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: 'cancel-acquisition',
  })
  await expect.poll(() => started).toBe(true)
  runtime.cancel(first.jobIds[0])
  await expect
    .poll(() => runtime.inspect(first.jobIds[0]).state)
    .toBe('cancelled')
  expect(runtime.list({ state: 'active' }).jobs).toEqual([])
  const next = runtime.createRequest({
    intent: 'continue',
    fromJobId: first.jobIds[0],
    idempotencyKey: 'fresh-acquisition',
  })
  await expect
    .poll(() => runtime.inspect(next.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(next.jobIds[0])).toMatchObject({
    state: 'succeeded',
    counts: { added: 1 },
    continuation: { restarted: true, restartReason: 'SNAPSHOT_INVALID' },
    budget: { discoveryUsed: 1 },
  })
  expect(attempts).toBe(2)
})

test('a failed export and an absent offer never extend an earlier successful offer check', async () => {
  const clock = testClock(0)
  let status = 200
  let body = csv
  const runtime = openRuntime(':memory:', 0, {
    ...clock,
    adapters: [adapter()],
    transport: async () => ({ status, body }),
  })
  runtimes.push(runtime)
  const run = async (key: string) => {
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'manual_refresh',
      idempotencyKey: key,
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    return runtime.inspect(request.jobIds[0])
  }
  expect((await run('successful-check')).state).toBe('succeeded')
  const saved = runtime.results({ area: initialArea, showUnavailable: true })
    .listings[0]
  clock.advance(86400001)
  status = 403
  expect((await run('failed-check')).state).toBe('failed')
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings[0],
  ).toEqual(saved)
  status = 200
  body = header
  expect(await run('absent-check')).toMatchObject({
    state: 'failed',
    counts: { rejected: 1 },
  })
  expect(
    runtime.results({ area: initialArea, showUnavailable: true }).listings[0],
  ).toEqual(saved)
})

test('worker shutdown recovers an interrupted acquired snapshot without replaying committed rows or HTTP', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'tsubata-restart-'))
  const path = join(directory, 'db.sqlite')
  let attempts = 0
  const options = {
    ...testClock(0),
    adapters: [adapter()],
    transport: async () => {
      attempts++
      return { status: 200, body: csv + row('000000002') + row('000000003') }
    },
  }
  let runtime = openRuntime(path, 0, options)
  runtimes.push(runtime)
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'interrupted',
    })
    const id = first.jobIds[0]
    for (
      const deadline = Date.now() + 3000;
      Date.now() < deadline && runtime.inspect(id).counts.added === 0;
    )
      await new Promise<void>((resolve) => setImmediate(resolve))
    await runtime.close()
    runtime = openRuntime(path, 0, options)
    runtimes.push(runtime)
    await expect.poll(() => runtime.inspect(id).stage).toBe('finished')
    expect(runtime.inspect(id)).toMatchObject({
      state: 'succeeded',
      counts: { checked: 3, added: 3 },
      budget: { discoveryUsed: 1, detailUsed: 0 },
    })
    expect(
      runtime.results({ area: initialArea, showUnavailable: true }).listings,
    ).toHaveLength(3)
    expect(attempts).toBe(1)
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
