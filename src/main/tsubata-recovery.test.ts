import { afterEach, expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { testClock } from './test-clock'
import { tsubataSnapshotAdapter } from './tsubata-snapshot'
import { fixtures } from './fixtures'
import { initialArea } from '../shared/geography'

const runtimes: ImportRuntime[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())) })
const csv = '全国地方公共団体コード,ID,契約形態,金額,受付状況\n173614,TBB000000001,売買,100,受付中\n'
function adapter() {
  return tsubataSnapshotAdapter({
    parserVersion: 'fixture-v1',
    candidate(row) {
      return { externalId: row.ID, transactionType: 'sale', url: 'https://www.town.tsubata.lg.jp/division/file/opendata/173614_empty_bank.csv', location: fixtures[0].location, municipalityId: null, publishedAt: null, modifiedAt: null, relevance: 'plausible' }
    },
    normalize(evidence) {
      return { kind: 'accepted', observation: { identity: evidence.identity, url: evidence.url, adapterVersion: 'tsubata-snapshot-v1', sourceCheckedAt: evidence.fetchedAt, fields: { ...fixtures[0], titleJa: 'Synthetic CSV offer' }, provenance: {}, contentHash: 'fixture' } }
    },
  })
}
test('a shared permitted export supplies successful offer checks without fictional detail requests', async () => {
  const requests: string[] = []
  const runtime = new ImportRuntime(':memory:', 0, { ...testClock(0), adapters: [adapter()], transport: async url => { requests.push(url); return {status: 200, body: csv} } })
  runtimes.push(runtime)
  const request = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'first'})
  await expect.poll(() => runtime.inspect(request.jobIds[0]).stage).toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({state: 'succeeded', counts: {added: 1, checked: 1}, budget: {discoveryUsed: 1, detailUsed: 0}})
  expect(requests).toEqual(['https://www.town.tsubata.lg.jp/division/file/opendata/173614_empty_bank.csv'])
  expect(runtime.results({area: initialArea, showUnavailable: true}).listings).toHaveLength(1)
})

test('bounded processing continues the same fully acquired snapshot after restart without more HTTP', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'tsubata-snapshot-'))
  const path = join(directory, 'db.sqlite')
  const requests: string[] = []
  const options = {...testClock(0), rowLimit: 1, adapters: [adapter()], transport: async (url: string) => {requests.push(url); return {status: 200, body: csv + '173614,TBB000000002,売買,200,受付中\n'}}}
  let runtime = new ImportRuntime(path, 0, options)
  runtimes.push(runtime)
  try {
    const first = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'bounded'})
    await expect.poll(() => runtime.inspect(first.jobIds[0]).stage).toBe('finished')
    const original = runtime.inspect(first.jobIds[0])
    expect(original).toMatchObject({state: 'partial', counts: {added: 1}, continuation: {available: true}, coverage: {lastSuccessfulCheckAt: null}})
    await runtime.close()
    runtime = new ImportRuntime(path, 0, options)
    runtimes.push(runtime)
    const next = runtime.createRequest({intent: 'continue', fromJobId: original.id, idempotencyKey: 'next'})
    await expect.poll(() => runtime.inspect(next.jobIds[0]).stage).toBe('finished')
    expect(runtime.inspect(next.jobIds[0])).toMatchObject({state: 'succeeded', counts: {added: 1, checked: 1}, budget: {discoveryUsed: 0, detailUsed: 0}})
    expect(runtime.inspect(original.id)).toEqual(original)
    expect(requests).toHaveLength(1)
    expect(runtime.results({area: initialArea, showUnavailable: true}).listings).toHaveLength(2)
  } finally {await runtime.close(); rmSync(directory, {recursive: true, force: true})}
})

test('truncated HTTP acquisition cannot certify coverage or retain a reusable snapshot', async () => {
  let attempts = 0
  const runtime = new ImportRuntime(':memory:', 0, {...testClock(0), adapters: [adapter()], transport: async () => { attempts++; return {status: 200, headers: {'Content-Length': '999'}, body: csv} }})
  runtimes.push(runtime)
  const request = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'truncated'})
  await expect.poll(() => runtime.inspect(request.jobIds[0]).stage).toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({state: 'failed', counts: {added: 0}, error: {code: 'TRUNCATED_RESPONSE'}, coverage: {lastSuccessfulCheckAt: null}})
  const next = runtime.createRequest({intent: 'continue', fromJobId: request.jobIds[0], idempotencyKey: 'retry'})
  await expect.poll(() => runtime.inspect(next.jobIds[0]).stage).toBe('finished')
  expect(attempts).toBe(2)
})

test('an isolated invalid row preserves valid offers and truthful rejected counts without complete coverage', async () => {
  const runtime = new ImportRuntime(':memory:', 0, {...testClock(0), adapters: [adapter()], transport: async () => ({status: 200, body: csv + '173614,TBB000000002,売買,200,受付中,unexpected\n'})})
  runtimes.push(runtime)
  const request = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'invalid-row'})
  await expect.poll(() => runtime.inspect(request.jobIds[0]).stage).toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({state: 'partial', counts: {added: 1, rejected: 1}, coverage: {lastSuccessfulCheckAt: null}, sources: [{coverage: 'partial'}]})
  expect(runtime.results({area: initialArea, showUnavailable: true}).listings).toHaveLength(1)
})

test('HTML challenges stop access without retries or endpoint fallback', async () => {
  const requests: string[] = []
  const runtime = new ImportRuntime(':memory:', 0, {...testClock(0), adapters: [adapter()], transport: async url => {requests.push(url); return {status: 200, headers: {'content-type': 'text/html'}, body: '<html>Verify you are human: CAPTCHA</html>'}}})
  runtimes.push(runtime)
  const request = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'challenge'})
  await expect.poll(() => runtime.inspect(request.jobIds[0]).stage).toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({state: 'failed', error: {code: 'SOURCE_BLOCKED'}, budget: {discoveryUsed: 1}})
  expect(requests).toHaveLength(1)
})

test('total physical response bytes include failed retries and stop before another request exceeds the budget', async () => {
  const attempts: number[] = []
  const clock = testClock(0)
  const runtime = new ImportRuntime(':memory:', 0, {...clock, byteLimit: 10, adapters: [adapter()], transport: async () => {attempts.push(clock.now()); return {status: 503, body: '123456'}}})
  runtimes.push(runtime)
  const request = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'bytes'})
  await expect.poll(() => runtime.inspect(request.jobIds[0]).stage).toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({state: 'failed', error: {code: 'BYTE_BUDGET_EXHAUSTED'}, budget: {discoveryUsed: 2, byteUsed: 12, byteLimit: 10}})
  expect(attempts).toEqual([0, 10000])
})

test('a stale processing snapshot restarts against a fresh fingerprint inside the continuation budget', async () => {
  const clock = testClock(0)
  let replacement = false
  let attempts = 0
  const runtime = new ImportRuntime(':memory:', 0, {...clock, rowLimit: 1, adapters: [adapter()], transport: async () => {attempts++; return {status: 200, body: replacement ? csv + '173614,TBB000000003,売買,300,受付中\n' : csv + '173614,TBB000000002,売買,200,受付中\n'}}})
  runtimes.push(runtime)
  const first = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'old-snapshot'})
  await expect.poll(() => runtime.inspect(first.jobIds[0]).stage).toBe('finished')
  clock.advance(86400001)
  replacement = true
  const next = runtime.createRequest({intent: 'continue', fromJobId: first.jobIds[0], idempotencyKey: 'changed-snapshot'})
  await expect.poll(() => runtime.inspect(next.jobIds[0]).stage).toBe('finished')
  expect(runtime.inspect(next.jobIds[0])).toMatchObject({state: 'partial', continuation: {restarted: true, restartReason: 'SNAPSHOT_INVALID'}, budget: {discoveryUsed: 1}, coverage: {lastSuccessfulCheckAt: null}})
  expect(attempts).toBe(2)
  expect(runtime.results({area: initialArea, showUnavailable: true}).listings.map(listing => listing.sourceRefs[0].externalId)).not.toContain('TBB000000002')
})

test('a redirect cannot widen the permitted CSV transport to a town asset', async () => {
  const requests: string[] = []
  const runtime = new ImportRuntime(':memory:', 0, {...testClock(0), adapters: [adapter()], transport: async url => {requests.push(url); return requests.length === 1 ? {status: 302, headers: {location: '/uploaded/attachment/asset.pdf'}} : {status: 200, body: csv}}})
  runtimes.push(runtime)
  const request = runtime.createRequest({area: initialArea, intent: 'import', idempotencyKey: 'asset'})
  await expect.poll(() => runtime.inspect(request.jobIds[0]).stage).toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({state: 'failed', error: {code: 'INVALID_SOURCE_URL'}, budget: {discoveryUsed: 1}})
  expect(requests).toHaveLength(1)
})
