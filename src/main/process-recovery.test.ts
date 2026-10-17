// @vitest-environment node
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { ImportJob, ImportRequest } from '../shared/desktop'
import type { AreaResults } from '../shared/listings'
import { initialArea } from '../shared/geography'

const directory = mkdtempSync(join(tmpdir(), 'akiya-process-recovery-'))
const bundle = join(directory, 'recovery-worker.mjs')
beforeAll(async () => {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: resolve('src/main/test-fixtures/recovery-worker.ts'),
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'recovery-worker.mjs' } },
    },
  })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))
type Snapshot = {
  request: ImportRequest
  job: ImportJob
  results: AreaResults
  starts: number[]
}
class Worker {
  child: ChildProcess
  private sequence = 0
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private events = new Map<string, unknown>()
  constructor(path: string, mode: string, epoch = 0) {
    this.child = fork(bundle, [path, mode, String(epoch)], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    this.child.on(
      'message',
      (message: {
        id?: number
        event?: string
        result?: unknown
        error?: string
      }) => {
        if (message.event) this.events.set(message.event, message)
        if (message.id) {
          const pending = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) pending?.reject(new Error(message.error))
          else pending?.resolve(message.result)
        }
      },
    )
    this.child.on('exit', () => {
      for (const pending of this.pending.values())
        pending.reject(new Error('Worker exited before acknowledgement'))
      this.pending.clear()
    })
  }
  async event(name: string) {
    await expect.poll(() => this.events.has(name), { timeout: 5000 }).toBe(true)
    return this.events.get(name) as Snapshot
  }
  call<T>(operation: string, input?: unknown): Promise<T> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.child.send({ id, operation, input })
    })
  }
  async kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve())
      this.child.kill('SIGKILL')
    })
  }
}
const input = { area: initialArea, intent: 'import', idempotencyKey: 'durable' }
async function finish(worker: Worker, request: ImportRequest) {
  await worker.call('inspectImportRequest', request.id)
  await expect
    .poll(
      async () =>
        (await worker.call<ImportJob>('inspectImport', request.jobIds[0]))
          .state,
      { timeout: 5000 },
    )
    .toBe('succeeded')
  return worker.call<Snapshot>('snapshot')
}

test.each(['before-commit', 'after-commit', 'preterminal'])(
  'SIGKILL %s recovers saved identities and accounting without replaying committed effects',
  async (boundary) => {
    const path = join(directory, `${boundary}.sqlite`)
    const first = new Worker(path, boundary)
    let second: Worker | undefined
    try {
      await first.event('ready')
      const request = await first.call<ImportRequest>(
        'createImportRequest',
        input,
      )
      const interrupted = await first.event('boundary')
      const committed =
        boundary === 'before-commit' ? 0 : boundary === 'after-commit' ? 1 : 2
      expect(interrupted.job.counts).toMatchObject({
        checked: committed,
        added: committed,
      })
      expect(interrupted.results.listings).toHaveLength(committed)
      await first.kill()
      second = new Worker(path, 'recovered', 100000)
      await second.event('ready')
      const recovered = await finish(second, request)
      expect(recovered.job).toMatchObject({
        counts: {
          discovered: 2,
          checked: 2,
          added: 2,
          unchanged: 0,
          updated: 0,
        },
        budget: {
          discoveryUsed: 1,
          detailUsed: boundary === 'preterminal' ? 2 : 3,
        },
      })
      expect(recovered.request.id).toBe(request.id)
      expect(
        (await second.call<ImportRequest>('createImportRequest', input)).id,
      ).toBe(request.id)
      for (const listing of interrupted.results.listings)
        expect(
          recovered.results.listings.find((saved) => saved.id === listing.id),
        ).toEqual(listing)
      expect(recovered.results.listings).toHaveLength(2)
      expect(recovered.starts).toHaveLength(
        boundary === 'before-commit' ? 2 : boundary === 'after-commit' ? 1 : 0,
      )
    } finally {
      await first.kill()
      await second?.kill()
    }
  },
)

test('SIGKILL during Retry-After preserves the deadline and charged outbound attempt', async () => {
  const path = join(directory, 'retry.sqlite')
  const first = new Worker(path, 'retry')
  let second: Worker | undefined
  try {
    await first.event('ready')
    const request = await first.call<ImportRequest>(
      'createImportRequest',
      input,
    )
    await first.event('boundary')
    await first.kill()
    second = new Worker(path, 'retry-recovery', 1001)
    await second.event('ready')
    const recovered = await finish(second, request)
    expect(recovered.starts).toEqual([5000, 7000, 9000])
    expect(recovered.job.budget).toMatchObject({
      discoveryUsed: 2,
      detailUsed: 2,
    })
    expect(recovered.job.counts).toMatchObject({ added: 2, checked: 2 })
  } finally {
    await first.kill()
    await second?.kill()
  }
})

test('competing processes reclaim one expired executor and fence the still-live old worker', async () => {
  const path = join(directory, 'competing.sqlite')
  const stale = new Worker(path, 'before-commit')
  let second: Worker | undefined
  let third: Worker | undefined
  try {
    await stale.event('ready')
    const request = await stale.call<ImportRequest>(
      'createImportRequest',
      input,
    )
    await stale.event('boundary')
    second = new Worker(path, 'recovered', 100000)
    third = new Worker(path, 'recovered', 100000)
    await Promise.all([second.event('ready'), third.event('ready')])
    const [saved, competitor] = await Promise.all([
      finish(second, request),
      finish(third, request),
    ])
    expect(saved.job).toEqual(competitor.job)
    expect(saved.job).toMatchObject({
      counts: { discovered: 2, checked: 2, added: 2 },
      budget: { discoveryUsed: 1, detailUsed: 3 },
    })
    expect(saved.starts.length + competitor.starts.length).toBe(2)
    await stale.call('release')
    await stale.event('continued')
    // Query after the stale adapter's promise settles; its old observation must
    // neither reopen terminal work nor add an unchanged observation/count.
    const staleView = await stale.call<Snapshot>('snapshot')
    expect(staleView.job).toEqual(saved.job)
    expect(staleView.results.listings).toEqual(saved.results.listings)
    expect((await second.call<Snapshot>('snapshot')).job).toEqual(saved.job)
  } finally {
    await stale.kill()
    await second?.kill()
    await third?.kill()
  }
})

test.each(['succeeded', 'failed', 'partial', 'cancelled'])(
  'persisted %s work never reopens or schedules requests after process restart',
  async (state) => {
    const path = join(directory, `terminal-${state}.sqlite`)
    const first = new Worker(path, state)
    let second: Worker | undefined
    try {
      await first.event('ready')
      const request = await first.call<ImportRequest>(
        'createImportRequest',
        input,
      )
      if (state === 'cancelled') {
        await first.event('boundary')
        await first.call('cancelImportRequest', request.id)
        // Kill before the blocked adapter cooperates with cancellation: restart
        // must finalize the durable intent without sending another request.
        await first.kill()
      } else {
        await expect
          .poll(
            async () =>
              (await first.call<ImportJob>('inspectImport', request.jobIds[0]))
                .state,
          )
          .toBe(state)
      }
      const previous =
        state === 'cancelled'
          ? undefined
          : await first.call<Snapshot>('snapshot')
      await first.kill()
      second = new Worker(path, 'recovered', 100000)
      await second.event('ready')
      await second.call('inspectImportRequest', request.id)
      await expect
        .poll(
          async () =>
            (await second!.call<ImportJob>('inspectImport', request.jobIds[0]))
              .state,
        )
        .toBe(state)
      const saved = await second.call<Snapshot>('snapshot')
      expect(saved.starts).toEqual([])
      expect(saved.request.state).toBe(state)
      if (previous) {
        expect(saved.job).toEqual(previous.job)
        expect(saved.results.listings).toEqual(previous.results.listings)
      }
      expect(
        (await second.call<ImportRequest>('createImportRequest', input)).id,
      ).toBe(request.id)
      expect(await second.call('listImports', { state: 'active' })).toEqual({
        jobs: [],
      })
    } finally {
      await first.kill()
      await second?.kill()
    }
  },
)

test('a committed request survives SIGKILL before its IPC acknowledgement and reuses the original IDs', async () => {
  const path = join(directory, 'unacknowledged.sqlite')
  const first = new Worker(path, 'unacknowledged')
  let second: Worker | undefined
  try {
    await first.event('ready')
    const acknowledgement = expect(
      first.call('createImportRequest', input),
    ).rejects.toThrow('before acknowledgement')
    const committed = await first.event('boundary')
    expect(committed.request).toMatchObject({
      state: 'queued',
      jobIds: [committed.job.id],
    })
    await first.kill()
    await acknowledgement
    second = new Worker(path, 'recovered', 100000)
    await second.event('ready')
    const retry = await second.call<ImportRequest>('createImportRequest', input)
    expect(retry.id).toBe(committed.request.id)
    expect(retry.jobIds).toEqual(committed.request.jobIds)
    const recovered = await finish(second, retry)
    expect(recovered.job).toMatchObject({
      counts: { discovered: 2, checked: 2, added: 2 },
      budget: { discoveryUsed: 1, detailUsed: 2 },
    })
    expect(recovered.results.listings).toHaveLength(2)
  } finally {
    await first.kill()
    await second?.kill()
  }
})

test('repeated process interruption charges every outbound attempt and exhausts the persisted budget', async () => {
  const path = join(directory, 'bounded-replay.sqlite')
  let request: ImportRequest | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = new Worker(path, 'budget', attempt * 100000)
    try {
      await worker.event('ready')
      request ??= await worker.call<ImportRequest>('createImportRequest', input)
      await worker.event('boundary')
      const job = await worker.call<ImportJob>(
        'inspectImport',
        request.jobIds[0],
      )
      expect(job.budget.discoveryUsed).toBe(attempt + 1)
      expect(job.counts).toMatchObject({ added: 0, checked: 0 })
    } finally {
      await worker.kill()
    }
  }
  const recovered = new Worker(path, 'budget-final', 300000)
  try {
    await recovered.event('ready')
    await recovered.call('inspectImportRequest', request!.id)
    await expect
      .poll(
        async () =>
          (await recovered.call<ImportJob>('inspectImport', request!.jobIds[0]))
            .stage,
      )
      .toBe('finished')
    const saved = await recovered.call<Snapshot>('snapshot')
    expect(saved.job).toMatchObject({
      budget: { discoveryLimit: 3, discoveryUsed: 3, detailUsed: 0 },
      error: { code: 'BUDGET_EXHAUSTED' },
      counts: { discovered: 0, checked: 0, added: 0 },
    })
    expect(saved.starts).toEqual([])
    expect(saved.results.listings).toEqual([])
  } finally {
    await recovered.kill()
  }
})

test('lease takeover between the ownership read and accounting cannot overwrite current progress', async () => {
  const path = join(directory, 'account-race.sqlite')
  const stale = new Worker(path, 'account-race')
  let current: Worker | undefined
  try {
    await stale.event('ready')
    const request = await stale.call<ImportRequest>(
      'createImportRequest',
      input,
    )
    await stale.event('clock-check')
    current = new Worker(path, 'before-commit', 100000)
    await current.event('ready')
    await current.call('inspectImportRequest', request.id)
    await current.call('inspectImport', request.jobIds[0])
    await current.event('boundary')
    const owned = await current.call<Snapshot>('snapshot')
    expect(owned.job.budget).toMatchObject({ discoveryUsed: 1, detailUsed: 1 })
    writeFileSync(`${path}.release-clock`, '')
    const oldView = await stale.call<Snapshot>('snapshot')
    expect(oldView.job).toEqual(owned.job)
    expect(oldView.starts).toEqual([])
    await current.call('release')
    const saved = await finish(current, request)
    expect(saved.job).toMatchObject({
      counts: { discovered: 2, checked: 2, added: 2 },
      budget: { discoveryUsed: 1, detailUsed: 2 },
    })
  } finally {
    writeFileSync(`${path}.release-clock`, '')
    await stale.kill()
    await current?.kill()
  }
})
