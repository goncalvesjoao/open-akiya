// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { tsubataAdapter } from './tsubata'
import { loadTsubataGeography } from './tsubata-geography'
import { testClock } from './test-clock'
import type { SelectedArea } from '../shared/listings'

const directories: string[] = []
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true })
})
const square = [
  [135, 35],
  [135.1, 35],
  [135.1, 35.1],
  [135, 35.1],
  [135, 35],
]
async function scenario(rings = [square]) {
  const directory = mkdtempSync(join(tmpdir(), 'tsubata-reference-'))
  directories.push(directory)
  const path = join(directory, 'fictional-reference.json')
  const body = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { N03_007: '17361', N03_004: '津幡町' },
        geometry: { type: 'MultiPolygon', coordinates: [rings] },
      },
    ],
  })
  writeFileSync(path, body)
  const geography = loadTsubataGeography(path, {
    sha256: createHash('sha256').update(body).digest('hex'),
    edition: 'Fictional test geometry; no real boundary coordinates',
  })
  const requests: string[] = []
  const runtime = new ImportRuntime(join(directory, 'db.sqlite'), 0, {
    ...testClock(),
    ...geography.runtimeOptions,
    adapters: [tsubataAdapter(geography.adapterOptions)],
    transport: async (url) => {
      requests.push(url)
      return {
        status: 200,
        body: '全国地方公共団体コード,ID,構造,契約形態,金額,受付状況,備考,所在地_町字\n173614,TBB000000001,木造住宅,売買,100,受付中,,字架空\n',
      }
    },
  })
  runtimes.push(runtime)
  async function run(area: SelectedArea) {
    const request = runtime.createRequest({
      area,
      intent: 'manual_refresh',
      idempotencyKey: JSON.stringify(area),
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).stage)
      .toBe('finished')
    return runtime.inspect(request.jobIds[0])
  }
  return { runtime, requests, run }
}
test('a privately supplied polygon gates export discovery and produces a documented municipality summary', async () => {
  const { runtime, requests, run } = await scenario()
  const area = { center: { latitude: 35.01, longitude: 135.01 }, radiusKm: 0.1 }
  expect(await run(area)).toMatchObject({
    state: 'succeeded',
    counts: { added: 1 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  const result = runtime.results({ area, showUnavailable: true })
  expect(result.listings[0].location).toEqual({
    kind: 'municipality',
    municipalityId: '173614',
  })
  expect(result.municipalityGroups[0]).toMatchObject({
    count: 1,
    representativePoint: { latitude: 35.05, longitude: 135.05 },
    representativePointProvenance: expect.stringContaining('scanline'),
  })
  expect(requests).toHaveLength(1)
})

test.each([
  ['outside west edge but overlapping', 35.05, 134.999, 0.1, true],
  [
    'outside corner within its bounding box expansion only',
    34.999,
    134.999,
    0.1,
    false,
  ],
  ['outside corner overlapping polygon', 34.999, 134.999, 0.15, true],
  ['center on boundary', 35, 135.05, 0.001, true],
  ['far from municipality', 34, 134, 1, false],
] as const)(
  'private polygon selects %s without broader discovery',
  async (_label, latitude, longitude, radiusKm, intersects) => {
    const { run, requests } = await scenario()
    expect(
      await run({ center: { latitude, longitude }, radiusKm }),
    ).toMatchObject({
      state: 'succeeded',
      coverage: { status: 'complete' },
      counts: { added: intersects ? 1 : 0 },
      budget: { discoveryUsed: intersects ? 1 : 0, detailUsed: 0 },
    })
    expect(requests).toHaveLength(intersects ? 1 : 0)
  },
)

test('polygon holes exclude selected areas until the circle reaches municipal territory', async () => {
  const hole = [
    [135.04, 35.04],
    [135.06, 35.04],
    [135.06, 35.06],
    [135.04, 35.06],
    [135.04, 35.04],
  ]
  const { run, requests, runtime } = await scenario([square, hole])
  const center = { latitude: 35.05, longitude: 135.05 }
  expect(await run({ center, radiusKm: 0.1 })).toMatchObject({
    state: 'succeeded',
    counts: { added: 0 },
    budget: { discoveryUsed: 0 },
  })
  expect(await run({ center, radiusKm: 1 })).toMatchObject({
    state: 'succeeded',
    counts: { added: 1 },
    budget: { discoveryUsed: 1 },
  })
  expect(
    runtime.results({ area: { center, radiusKm: 0.1 }, showUnavailable: true })
      .listings,
  ).toEqual([])
  expect(
    runtime.results({ area: { center, radiusKm: 1 }, showUnavailable: true })
      .municipalityGroups[0],
  ).toMatchObject({
    representativePoint: {
      latitude: expect.closeTo(35.02, 10),
      longitude: 135.05,
    },
    representativePointProvenance: expect.stringContaining('holes excluded'),
  })
  expect(requests).toHaveLength(1)
})

test('an unavailable or unpinned private reference cannot configure discovery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tsubata-unpinned-'))
  directories.push(directory)
  const path = join(directory, 'reference.json')
  expect(() => loadTsubataGeography(path)).toThrow(
    'Private municipal reference file unavailable',
  )
  writeFileSync(path, '{}')
  expect(() => loadTsubataGeography(path)).toThrow(
    'Private municipal reference checksum mismatch',
  )
})

test('an oversized private reference reports its byte limit instead of an unavailable file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tsubata-oversized-'))
  directories.push(directory)
  const path = join(directory, 'reference.json')
  writeFileSync(path, '')
  truncateSync(path, 32 * 1024 * 1024 + 1)
  expect(() => loadTsubataGeography(path)).toThrow(
    'Municipal reference exceeds byte limit',
  )
})
