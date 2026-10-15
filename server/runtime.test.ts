import { afterAll, beforeAll, expect, test } from 'vitest'
import { Pool } from 'pg'
import { createRuntime } from './runtime'
import { runWorkerOnce } from './worker'
import { createSyntheticAdapter, syntheticTransport } from './synthetic'

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL })
let runtime: Awaited<ReturnType<typeof createRuntime>>
const area = { center: { latitude: 35, longitude: 135 }, radiusKm: 5 }
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error(
      'TEST_DATABASE_URL must name an isolated migrated Postgres database',
    )
  const database = await pool.query('select current_database() as name')
  if (!database.rows[0].name.startsWith('open_akiya_test_'))
    throw new Error('Use npm run test:server to create an isolated database')
  runtime = await createRuntime({
    pool,
    sessionToken: 'test-session-token',
    allowedOrigins: ['http://localhost:5173'],
  })
})
afterAll(async () => {
  await runtime?.close()
  await pool.end()
})
async function call(path: string, body?: unknown, key = crypto.randomUUID()) {
  return fetch(runtime.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: 'http://localhost:5173',
      'Content-Type': 'application/json',
      'X-Installation-Session': 'test-session-token',
      'Idempotency-Key': key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
test('invalid areas cannot create import requests', async () => {
  const response = await call('/api/import-requests', {
    area: { ...area, radiusKm: 0 },
    intent: 'import',
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      code: 'INVALID_REQUEST',
      message:
        'Choose finite coordinates and radius greater than 0 and at most 10 km.',
      retryable: false,
    },
  })
})
test('concurrent retries reuse durable request and immutable exact scope across API restart', async () => {
  const key = crypto.randomUUID()
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      call('/api/import-requests', { area, intent: 'import' }, key),
    ),
  )
  expect(responses.map((response) => response.status)).toEqual([
    202, 202, 202, 202, 202, 202,
  ])
  const requests = await Promise.all(
    responses.map((response) => response.json()),
  )
  expect(new Set(requests.map((request) => request.id)).size).toBe(1)
  expect(requests[0]).toMatchObject({
    area,
    intent: 'import',
    state: 'queued',
    disposition: 'created',
    pendingFollowUp: false,
  })
  await runtime.close()
  runtime = await createRuntime({
    pool,
    sessionToken: 'test-session-token',
    allowedOrigins: ['http://localhost:5173'],
  })
  const retry = await call(
    '/api/import-requests',
    { area, intent: 'import' },
    key,
  )
  expect(await retry.json()).toEqual(requests[0])
  const conflict = await call(
    '/api/import-requests',
    { area: { ...area, radiusKm: 5.000000000001 }, intent: 'import' },
    key,
  )
  expect(conflict.status).toBe(409)
  expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT')
  const job = await (
    await call('/api/import-jobs/' + requests[0].jobIds[0])
  ).json()
  expect(job).toMatchObject({
    area,
    state: 'queued',
    stage: 'queued',
    counts: { discovered: 0, checked: 0, added: 0 },
    budget: { discoveryLimit: 10, detailLimit: 100 },
  })
  const active = await (await call('/api/import-jobs?state=active')).json()
  expect(active.jobs.map((job: { id: string }) => job.id)).toContain(job.id)
})

test('independent worker saves one known-inside listing with committed counts and read-only results', async () => {
  const acknowledgement = await (
    await call('/api/import-requests', { area, intent: 'import' })
  ).json()
  const transportRequests: string[] = []
  while (
    await runWorkerOnce({
      pool,
      adapters: [createSyntheticAdapter()],
      transport: async (url, options) => {
        transportRequests.push(url)
        return syntheticTransport(url, options)
      },
    })
  ) {
    /* drain prior queued work too */
  }
  const job = await (
    await call('/api/import-jobs/' + acknowledgement.jobIds[0])
  ).json()
  expect(job).toMatchObject({
    state: 'succeeded',
    stage: 'finished',
    counts: { discovered: 1, checked: 1 },
    budget: { discoveryUsed: 1, detailUsed: 1 },
    sources: [
      {
        sourceId: 'fixture',
        state: 'succeeded',
        coverage: 'complete',
        error: null,
      },
    ],
  })
  expect(job.counts.added + job.counts.updated + job.counts.unchanged).toBe(1)
  expect(Date.parse(job.finishedAt)).toBeGreaterThanOrEqual(
    Date.parse(job.startedAt),
  )
  const beforeReads = transportRequests.length
  const saved = await (
    await call('/api/area-results', { area, showUnavailable: false })
  ).json()
  expect(saved.listings).toHaveLength(1)
  expect(saved.listings[0]).toMatchObject({
    titleJa: 'サンプル売却情報',
    transactionType: 'sale',
    salePriceJpy: 0,
    rentMonthlyJpy: null,
    sourceRefs: [{ sourceId: 'fixture', externalId: 'sale-1' }],
    location: {
      kind: 'unverified',
      point: { latitude: 35.001, longitude: 135 },
    },
  })
  expect(transportRequests.length).toBe(beforeReads)
  expect(
    await (await call('/api/import-requests/' + acknowledgement.id)).json(),
  ).toMatchObject({ state: 'succeeded', finishedAt: job.finishedAt })
  expect(JSON.stringify(saved)).not.toMatch(
    /contentHash|provenance|lease|payload|session-token/,
  )
})
test('two workers cannot overlap and progress reports real transport stages', async () => {
  const request = await (
    await call('/api/import-requests', { area, intent: 'import' })
  ).json()
  let release: () => void = () => {}
  let started: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = runWorkerOnce({
    pool,
    adapters: [createSyntheticAdapter()],
    transport: async (url, options) => {
      if (url.endsWith('/discovery')) {
        started()
        await barrier
      }
      return syntheticTransport(url, options)
    },
  })
  await waiting
  const running = await (
    await call('/api/import-jobs/' + request.jobIds[0])
  ).json()
  expect(running).toMatchObject({
    state: 'running',
    stage: 'discovering',
    counts: { checked: 0, added: 0 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(
    await runWorkerOnce({
      pool,
      adapters: [createSyntheticAdapter()],
      transport: syntheticTransport,
    }),
  ).toBe(false)
  release()
  expect(await first).toBe(true)
  expect(
    await (await call('/api/import-jobs/' + request.jobIds[0])).json(),
  ).toMatchObject({ state: 'succeeded', counts: { unchanged: 1 } })
})
test('mutations require allowed origin and installation session; empty sources fail explicitly', async () => {
  const variants: Record<string, string>[] = [
    {
      Origin: 'https://evil.invalid',
      'X-Installation-Session': 'test-session-token',
    },
    { Origin: 'http://localhost:5173' },
    { 'X-Installation-Session': 'test-session-token' },
  ]
  for (const headers of variants) {
    const denied = await fetch(runtime.url + '/api/import-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ area, intent: 'import' }),
    })
    expect(denied.status).toBe(403)
  }
  const disabled = await createRuntime({
    pool,
    sessionToken: 'test-session-token',
    allowedOrigins: ['http://localhost:5173'],
    sources: [],
  })
  try {
    const result = await fetch(disabled.url + '/api/import-requests', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-Installation-Session': 'test-session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ area, intent: 'import' }),
    })
    expect(result.status).toBe(409)
    expect((await result.json()).error.code).toBe('NO_ENABLED_SOURCES')
  } finally {
    await disabled.close()
  }
})
test('source errors are sanitized and cannot clear saved results', async () => {
  const request = await (
    await call('/api/import-requests', { area, intent: 'import' })
  ).json()
  await runWorkerOnce({
    pool,
    adapters: [createSyntheticAdapter()],
    transport: async () => {
      throw new Error(
        'postgres://private:password@secret-host/raw?token=hidden',
      )
    },
  })
  const result = await (
    await call('/api/import-jobs/' + request.jobIds[0])
  ).json()
  expect(result).toMatchObject({
    state: 'failed',
    stage: 'finished',
    counts: { added: 0, checked: 0 },
    error: { code: 'SOURCE_ERROR' },
  })
  expect(JSON.stringify(result)).not.toMatch(
    /password|secret-host|token=hidden|postgres:/,
  )
  expect(
    (
      await (
        await call('/api/area-results', { area, showUnavailable: false })
      ).json()
    ).listings,
  ).toHaveLength(1)
})

test('all invalid area shapes leave active jobs unchanged and perform no collection', async () => {
  const before = await (await call('/api/import-jobs?state=active')).json()
  for (const invalid of [
    null,
    {},
    { center: { latitude: '35', longitude: 135 }, radiusKm: 5 },
    { ...area, radiusKm: 10.01 },
    { ...area, radiusKm: null },
    { ...area, center: { latitude: 91, longitude: 135 } },
    { ...area, extra: 'not-an-area-member' },
  ]) {
    expect(
      (await call('/api/import-requests', { area: invalid, intent: 'import' }))
        .status,
    ).toBe(400)
  }
  expect(await (await call('/api/import-jobs?state=active')).json()).toEqual(
    before,
  )
  expect((await call('/api/import-jobs/not-known')).status).toBe(404)
})
test('source evidence cannot add operational or raw fields to the approved listing response', async () => {
  await call('/api/import-requests', { area, intent: 'import' })
  await runWorkerOnce({
    pool,
    adapters: [createSyntheticAdapter()],
    transport: async (url, options) => {
      const response = await syntheticTransport(url, options)
      return url.includes('/offers/')
        ? Response.json({
            ...(await response.json()),
            rawEvidence: 'private source body',
            leaseOwner: 'private executor',
          })
        : response
    },
  })
  const saved = await (
    await call('/api/area-results', { area, showUnavailable: false })
  ).json()
  expect(saved.listings).toHaveLength(1)
  expect(JSON.stringify(saved)).not.toMatch(
    /rawEvidence|leaseOwner|private source body|private executor/,
  )
})
