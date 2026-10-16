// @vitest-environment node
import { expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { testClock } from './test-clock'
import { initialArea } from '../shared/geography'

test('acknowledges a durable base intent and inspects its separate job', async () => {
  const runtime = new ImportRuntime(':memory:', 1, testClock())
  try {
    const request = await runtime.dispatch('createImportRequest', {
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'request-one',
    })
    expect(request).toMatchObject({
      intent: 'import',
      disposition: 'created',
      state: 'queued',
      pendingFollowUp: false,
    })
  } finally {
    await runtime.close()
  }
})

test('idempotency persists separate request and job across worker restart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'request-'))
  const path = join(dir, 'db.sqlite')
  let runtime = new ImportRuntime(path, 1)
  try {
    const input = {
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'persisted',
    }
    const first = runtime.createRequest(input)
    expect(first.id).not.toBe(first.jobIds[0])
    expect(runtime.createRequest(input)).toEqual(first)
    expect(() =>
      runtime.createRequest({
        ...input,
        area: { ...initialArea, radiusKm: 4.999999999 },
      }),
    ).toThrow('Idempotency')
    await runtime.close()
    runtime = new ImportRuntime(path, 1)
    expect(runtime.createRequest(input).id).toBe(first.id)
    expect(runtime.inspectRequest(first.id).jobIds).toEqual(first.jobIds)
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('covering active work keeps independent immutable request intent', async () => {
  const runtime = new ImportRuntime(':memory:', 1, testClock())
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'cover',
    })
    const area = { ...initialArea, radiusKm: 1 }
    const second = runtime.createRequest({
      area,
      intent: 'import',
      idempotencyKey: 'inside',
    })
    expect(second).toMatchObject({
      disposition: 'attached',
      area,
      jobIds: first.jobIds,
    })
    expect(second.id).not.toBe(first.id)
    expect(runtime.list({ state: 'active' }).jobs).toHaveLength(1)
    await expect
      .poll(() => runtime.inspectRequest(second.id).state)
      .toBe('succeeded')
    expect(runtime.inspectRequest(first.id)).toMatchObject({
      id: first.id,
      area: initialArea,
    })
    expect(runtime.inspectRequest(second.id)).toMatchObject({
      id: second.id,
      area,
    })
  } finally {
    await runtime.close()
  }
})

test('cancelling an intent detaches only it and last-owner cancellation stops work', async () => {
  const runtime = new ImportRuntime(':memory:', 100, testClock())
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'owner1',
    })
    const second = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'owner2',
    })
    expect(
      await runtime.dispatch('cancelImportRequest', first.id),
    ).toMatchObject({ id: first.id, state: 'cancelled' })
    expect(runtime.inspect(second.jobIds[0]).state).toBe('queued')
    expect(runtime.inspectRequest(second.id).state).toBe('queued')
    await runtime.dispatch('cancelImportRequest', second.id)
    expect(runtime.inspect(second.jobIds[0]).state).toBe('cancelled')
    expect(runtime.inspectRequest(first.id)).toMatchObject({
      id: first.id,
      state: 'cancelled',
    })
  } finally {
    await runtime.close()
  }
})

test('queued overlapping work reuses details checked while waiting without borrowing coverage', async () => {
  const runtime = new ImportRuntime(':memory:', 1, testClock())
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'overlap-first',
    })
    const area = {
      ...initialArea,
      center: { ...initialArea.center, longitude: 135.01 },
    }
    const second = runtime.createRequest({
      area,
      intent: 'import',
      idempotencyKey: 'overlap-second',
    })
    expect(second.disposition).toBe('created')
    expect(second.jobIds).not.toEqual(first.jobIds)
    await expect
      .poll(() => runtime.inspect(second.jobIds[0]).state)
      .toBe('succeeded')
    expect(runtime.inspect(second.jobIds[0])).toMatchObject({
      area,
      counts: { discovered: 1, checked: 0 },
      budget: { detailUsed: 0 },
    })
    expect(
      runtime.results({ area, showUnavailable: true }).listings,
    ).toHaveLength(1)
  } finally {
    await runtime.close()
  }
})

test('explicit job cancellation cancels every unfinished owner and terminal intent never reopens', async () => {
  const runtime = new ImportRuntime(':memory:', 1, testClock())
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'job-owner1',
    })
    const second = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'job-owner2',
    })
    runtime.cancel(first.jobIds[0])
    expect(runtime.inspectRequest(first.id)).toMatchObject({
      id: first.id,
      state: 'cancelled',
    })
    expect(runtime.inspectRequest(second.id)).toMatchObject({
      id: second.id,
      state: 'cancelled',
    })
    const next = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'job-next',
    })
    expect(next.jobIds).not.toEqual(first.jobIds)
    await expect
      .poll(() => runtime.inspectRequest(next.id).state)
      .toBe('succeeded')
    expect(runtime.inspectRequest(first.id).state).toBe('cancelled')
    expect(
      await runtime.dispatch('cancelImportRequest', next.id),
    ).toMatchObject({ state: 'succeeded' })
  } finally {
    await runtime.close()
  }
})

test('detached cancelled owner remains terminal while shared execution completes', async () => {
  const runtime = new ImportRuntime(':memory:', 1, testClock())
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'detached',
    })
    const second = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'remaining',
    })
    await runtime.dispatch('cancelImportRequest', first.id)
    await expect
      .poll(() => runtime.inspectRequest(second.id).state)
      .toBe('succeeded')
    expect(runtime.inspectRequest(first.id)).toMatchObject({
      id: first.id,
      area: initialArea,
      state: 'cancelled',
    })
    expect(runtime.inspect(second.jobIds[0]).counts.added).toBe(1)
  } finally {
    await runtime.close()
  }
})

test('source version changes prevent attachment even for identical circles', async () => {
  const { syntheticAdapter } = await import('./adapter')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'scope-'))
  const adapter = syntheticAdapter(1)
  const first = new ImportRuntime(join(dir, 'db'), 1, {
    ...testClock(),
    adapters: [adapter],
  })
  const second = new ImportRuntime(join(dir, 'db'), 1, {
    ...testClock(),
    adapters: [
      {
        ...adapter,
        capabilities: { ...adapter.capabilities, queryVersion: 'different' },
      },
    ],
  })
  try {
    const one = first.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'version1',
    })
    const two = second.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'version2',
    })
    expect(two.disposition).toBe('created')
    expect(two.jobIds).not.toEqual(one.jobIds)
  } finally {
    await first.close()
    await second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two connections attach different keys atomically and cancellation only stops the final owner', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'owners-'))
  const first = new ImportRuntime(join(dir, 'db'), 1, testClock())
  const second = new ImportRuntime(join(dir, 'db'), 1, testClock())
  try {
    const [one, two] = (await Promise.all([
      first.dispatch('createImportRequest', {
        area: initialArea,
        intent: 'import',
        idempotencyKey: 'race1',
      }),
      second.dispatch('createImportRequest', {
        area: initialArea,
        intent: 'import',
        idempotencyKey: 'race2',
      }),
    ])) as import('../shared/desktop').ImportRequest[]
    expect(one.jobIds).toEqual(two.jobIds)
    expect(first.list({ state: 'active' }).jobs).toHaveLength(1)
    await first.dispatch('cancelImportRequest', one.id)
    expect(second.inspect(two.jobIds[0]).cancelRequestedAt).toBeNull()
    await second.dispatch('cancelImportRequest', two.id)
    expect(first.inspect(one.jobIds[0]).state).toBe('cancelled')
    expect(first.inspectRequest(one.id)).toMatchObject({
      id: one.id,
      state: 'cancelled',
    })
  } finally {
    await first.close()
    await second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a retained queued execution re-evaluates newly completed covering cache after restart', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { syntheticAdapter } = await import('./adapter')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'queue-recovery-'))
  const path = join(dir, 'db')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  let runtime = new ImportRuntime(path, 1, clock)
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'cache-cover',
    })
    const queuedJob = {
      ...runtime.inspect(first.jobIds[0]),
      id: 'retained-queue',
    }
    const queuedRequest = {
      ...first,
      id: 'retained-request',
      jobIds: [queuedJob.id],
    }
    await runtime.close()
    // Retained queue is an external restart fixture; observations remain through the API.
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO import_jobs_v2 VALUES (?,?,?,?,?)').run(
      queuedJob.id,
      queuedJob.state,
      JSON.stringify(queuedJob),
      JSON.stringify({
        area: initialArea,
        sources: [syntheticAdapter(1).capabilities],
        filters: { residential: true },
        referenceVersion: 'synthetic-v1',
      }),
      JSON.stringify({
        sourceIndex: 0,
        cursor: null,
        candidates: [],
        candidateIndex: 0,
        exhausted: false,
        limitation: null,
        discovered: [],
        completed: [],
      }),
    )
    db.prepare('INSERT INTO import_requests_v2 VALUES (?,?,?,?,?)').run(
      queuedRequest.id,
      'retained-key',
      JSON.stringify({ area: initialArea, intent: 'import' }),
      queuedJob.id,
      JSON.stringify(queuedRequest),
    )
    const detachedRequest = {
      ...queuedRequest,
      id: 'detached-retained-request',
      state: 'cancelled',
      finishedAt: first.createdAt,
    }
    db.prepare('INSERT INTO import_requests_v2 VALUES (?,?,?,?,?)').run(
      detachedRequest.id,
      'detached-retained-key',
      JSON.stringify({ area: initialArea, intent: 'import' }),
      queuedJob.id,
      JSON.stringify(detachedRequest),
    )
    db.close()
    runtime = new ImportRuntime(path, 1, clock)
    await expect
      .poll(() => runtime.inspectRequest(queuedRequest.id).state)
      .toBe('succeeded')
    expect(runtime.inspectRequest(detachedRequest.id)).toEqual(detachedRequest)
    const covering = runtime.inspect(first.jobIds[0])
    expect(runtime.inspectRequest(queuedRequest.id)).toMatchObject({
      disposition: 'cached',
      area: initialArea,
      jobIds: first.jobIds,
    })
    expect(runtime.inspect(queuedJob.id)).toMatchObject({
      state: 'succeeded',
      counts: { discovered: 0, checked: 0 },
      budget: { discoveryUsed: 0, detailUsed: 0 },
      coverage: covering.coverage,
    })
    expect(
      await runtime.dispatch('cancelImportRequest', queuedRequest.id),
    ).toMatchObject({ state: 'succeeded' })
    expect(runtime.inspect(first.jobIds[0])).toEqual(covering)
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a running covering job keeps its remaining owner after a request detaches', async () => {
  const { syntheticAdapter } = await import('./adapter')
  const base = syntheticAdapter(1)
  let entered = false
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = new ImportRuntime(':memory:', 1, {
    ...testClock(),
    adapters: [
      {
        ...base,
        async fetchDetail(candidate, context) {
          entered = true
          await gate
          return base.fetchDetail(candidate, context)
        },
      },
    ],
  })
  try {
    const first = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'running-first',
    })
    await expect.poll(() => entered).toBe(true)
    const second = runtime.createRequest({
      area: { ...initialArea, radiusKm: 1 },
      intent: 'import',
      idempotencyKey: 'running-second',
    })
    expect(second).toMatchObject({
      state: 'running',
      disposition: 'attached',
      jobIds: first.jobIds,
    })
    await runtime.dispatch('cancelImportRequest', first.id)
    expect(runtime.inspect(first.jobIds[0]).cancelRequestedAt).toBeNull()
    release()
    await expect
      .poll(() => runtime.inspectRequest(second.id).state)
      .toBe('succeeded')
    expect(runtime.inspectRequest(first.id).state).toBe('cancelled')
    expect(runtime.inspect(first.jobIds[0]).counts.checked).toBe(1)
  } finally {
    release()
    await runtime.close()
  }
})

test('a queued overlap rechecks detail exactly at its expiry', async () => {
  const { syntheticAdapter } = await import('./adapter')
  const clock = testClock(Date.parse('2026-10-16T00:00:00Z'))
  const base = syntheticAdapter(1)
  let discoveries = 0
  const runtime = new ImportRuntime(':memory:', 1, {
    ...clock,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          if (++discoveries === 2) clock.advance(86400000)
          return base.discover(input, context)
        },
      },
    ],
  })
  try {
    runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'expiry-first',
    })
    const second = runtime.createRequest({
      area: { ...initialArea, center: { latitude: 35, longitude: 135.01 } },
      intent: 'import',
      idempotencyKey: 'expiry-second',
    })
    await expect
      .poll(() => runtime.inspectRequest(second.id).state)
      .toBe('succeeded')
    expect(runtime.inspect(second.jobIds[0])).toMatchObject({
      counts: { checked: 1, unchanged: 1 },
      budget: { detailUsed: 1 },
    })
  } finally {
    await runtime.close()
  }
})
