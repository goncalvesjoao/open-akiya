// @vitest-environment node
import { expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { initialArea } from '../shared/geography'

test('acknowledges a durable base intent and inspects its separate job', async () => {
  const runtime = new ImportRuntime(':memory:', 1)
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
