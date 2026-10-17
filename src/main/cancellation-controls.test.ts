// @vitest-environment node
import { expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { testClock } from './test-clock'
import {
  attachedImportRequest,
  overlappingQueuedImportJob,
} from '../shared/import-fixtures'
import {
  cancelledAttachedRequest,
  cancelledQueuedImportJob,
  cancellationRequestedJob,
} from '../shared/cancellation-fixtures'
import { initialArea } from '../shared/geography'

test('shared cancellation response recipes retain owners, queue order and completed outcomes through SQLite API', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-cancel-controls-'))
  const base = syntheticAdapter(0)
  let entered = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = new ImportRuntime(join(directory, 'db.sqlite'), 0, {
    ...testClock(),
    adapters: [
      {
        ...base,
        async discover(input, context) {
          entered = true
          await gate
          return base.discover(input, context)
        },
      },
    ],
  })
  const request = (key: string, area = initialArea) =>
    runtime.createRequest({ area, intent: 'import', idempotencyKey: key })
  try {
    const first = request('first')
    await expect.poll(() => entered).toBe(true)
    const attached = request('attached', attachedImportRequest.area)
    expect(attached).toMatchObject({
      area: attachedImportRequest.area,
      disposition: attachedImportRequest.disposition,
      state: attachedImportRequest.state,
      jobIds: first.jobIds,
    })
    const detached = await runtime.dispatch('cancelImportRequest', attached.id)
    expect(detached).toMatchObject({
      state: cancelledAttachedRequest.state,
      pendingFollowUp: cancelledAttachedRequest.pendingFollowUp,
      area: cancelledAttachedRequest.area,
    })
    expect(runtime.inspect(first.jobIds[0]).cancelRequestedAt).toBeNull()
    const overlap = request('overlap', overlappingQueuedImportJob.area)
    const other = request('other', {
      center: { latitude: 36, longitude: 136 },
      radiusKm: 5,
    })
    expect(runtime.list({ state: 'active' }).jobs.map((job) => job.id)).toEqual(
      [first.jobIds[0], overlap.jobIds[0], other.jobIds[0]],
    )
    expect(
      await runtime.dispatch('cancelImport', overlap.jobIds[0]),
    ).toMatchObject({
      area: cancelledQueuedImportJob.area,
      state: cancelledQueuedImportJob.state,
      stage: cancelledQueuedImportJob.stage,
      counts: cancelledQueuedImportJob.counts,
      reasons: cancelledQueuedImportJob.reasons,
    })
    expect(runtime.list({ state: 'active' }).jobs.map((job) => job.id)).toEqual(
      [first.jobIds[0], other.jobIds[0]],
    )
    release()
    await expect
      .poll(() => runtime.inspectRequest(other.id).state)
      .toBe('succeeded')
    const completed = runtime.inspect(first.jobIds[0])
    expect(await runtime.dispatch('cancelImport', completed.id)).toEqual(
      completed,
    )
    expect(runtime.inspectRequest(attached.id).state).toBe('cancelled')
    expect(runtime.inspect(overlap.jobIds[0]).state).toBe('cancelled')
  } finally {
    release()
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('running cancellation response stays pending until adapter settles without automatic resumption', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-cancel-pending-'))
  const path = join(directory, 'db.sqlite')
  const base = syntheticAdapter(0)
  let entered = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let runtime = new ImportRuntime(path, 0, {
    ...testClock(),
    adapters: [
      {
        ...base,
        async discover(input, context) {
          entered = true
          await gate
          return base.discover(input, context)
        },
      },
    ],
  })
  try {
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'pending',
    })
    await expect.poll(() => entered).toBe(true)
    const pending = await runtime.dispatch('cancelImport', request.jobIds[0])
    expect(pending).toMatchObject({
      state: cancellationRequestedJob.state,
      stage: cancellationRequestedJob.stage,
      reasons: cancellationRequestedJob.reasons,
      cancelRequestedAt: expect.any(String),
    })
    release()
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).state)
      .toBe('cancelled')
    await runtime.close()
    runtime = new ImportRuntime(path, 0, testClock())
    expect(runtime.list({ state: 'active' })).toEqual({ jobs: [] })
    expect(runtime.inspect(request.jobIds[0]).state).toBe('cancelled')
  } finally {
    release()
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
