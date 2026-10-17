// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { testClock } from './test-clock'
import { tsubataAdapter, TSUBATA_EXPORT } from './tsubata'
import { areasIntersect, initialArea } from '../shared/geography'
const directory = mkdtempSync(join(tmpdir(), 'akiya-tsubata-'))
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
const header = [
  '全国地方公共団体コード',
  'ID',
  '名称',
  '所在地_都道府県',
  '所在地_市区町村',
  '所在地_町字',
  '所在地_番地以下',
  '構造',
  '契約形態',
  '金額',
  '受付状況',
  'URL',
  '備考',
]
const row = (patch: Record<string, string> = {}) => ({
  全国地方公共団体コード: '173614',
  ID: 'TBB000000001',
  名称: '住宅',
  所在地_都道府県: '石川県',
  所在地_市区町村: '津幡町',
  所在地_町字: '字サンプル',
  所在地_番地以下: '地内',
  構造: '木造住宅',
  契約形態: '売買',
  金額: '1250000',
  受付状況: '受付中',
  URL: '',
  備考: '',
  ...patch,
})
function csv(rows: Record<string, string>[]) {
  return (
    [header, ...rows.map((r) => header.map((k) => r[k] ?? ''))]
      .map((r) => r.map((v) => `"${v.replaceAll('"', '""')}"`).join(','))
      .join('\r\n') + '\r\n'
  )
}
let key = 0
function open(
  body: () => string,
  adapter = tsubataAdapter({
    intersectsMunicipality: () => true,
    geographyVersion: 'synthetic-test-only',
  }),
) {
  const requests: string[] = []
  const path = join(directory, `${++key}.sqlite`)
  const runtime = new ImportRuntime(path, 0, {
    ...testClock(),
    referenceVersion: 'synthetic-test-only',
    municipalityReference: (id) =>
      id === '173614'
        ? { representativePoint: null, representativePointProvenance: null }
        : undefined,
    adapters: [adapter],
    areaFreshnessMs: 0,
    detailFreshnessMs: 0,
    transport: async (url) => {
      requests.push(url)
      return { status: 200, body: body() }
    },
  })
  runtimes.push(runtime)
  return { runtime, requests, path }
}
async function imported(runtime: ImportRuntime) {
  const req = runtime.createRequest({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: String(++key),
  })
  await expect
    .poll(() => runtime.inspect(req.jobIds[0]).state)
    .not.toMatch(/queued|running/)
  return runtime.inspect(req.jobIds[0])
}
const query = { area: initialArea, showUnavailable: true }
test('saves residential sale and monthly rental offers from one export, retaining municipality uncertainty and replay identity', async () => {
  const { runtime, requests } = open(() =>
    csv([row(), row({ 契約形態: '賃貸', 金額: '42000', 備考: '金額は月額' })]),
  )
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 2, rejected: 0 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(runtime.results(query).listings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        transactionType: 'sale',
        salePriceJpy: 1250000,
        location: { kind: 'municipality', municipalityId: '173614' },
        primarySourceUrl: TSUBATA_EXPORT,
        floorAreaM2: null,
        sourceRefs: [
          expect.objectContaining({ name: '津幡町 空き家バンク（CC BY 4.0）' }),
        ],
      }),
      expect.objectContaining({
        transactionType: 'rent',
        rentMonthlyJpy: 42000,
      }),
    ]),
  )
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 0, unchanged: 2 },
  })
  expect(requests).toEqual([TSUBATA_EXPORT, TSUBATA_EXPORT])
})

test('quarantines every ambiguous identity in a snapshot while retaining unrelated valid offers', async () => {
  const { runtime } = open(() =>
    csv([
      row(),
      row({ ID: 'TBB000000002' }),
      row({ ID: 'TBB000000003', 所在地_町字: '字別', 構造: '木造' }),
      row({ ID: '', 所在地_町字: '字空' }),
      row({ ID: 'TBB000000004', 所在地_町字: '字正常' }),
    ]),
  )
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 1, rejected: 4 },
    coverage: { status: 'partial' },
  })
  expect(
    runtime.results(query).listings.map((l) => l.sourceRefs[0].externalId),
  ).toEqual(['173614:TBB000000004'])
})

test.each([
  ['1250001', '', 1250001, false],
  ['1,250,000', '', 1250000, false],
  ['無料', '', 0, false],
  ['0', '無償', 0, false],
  ['', '', null, false],
  ['応相談', '', null, false],
  ['0', '', null, true],
  ['1.5', '', null, true],
  ['100万円', '', null, true],
  ['-1', '', null, true],
  ['9007199254740992', '', null, true],
  ['12,34', '', null, true],
])(
  'sale price %s retains evidenced yen or quarantines ambiguity',
  async (金額, 備考, expected, rejected) => {
    const { runtime } = open(() => csv([row({ 金額, 備考 })]))
    const result = await imported(runtime)
    expect(result.counts).toMatchObject({
      added: rejected ? 0 : 1,
      rejected: rejected ? 1 : 0,
    })
    expect(runtime.results(query).listings.map((l) => l.salePriceJpy)).toEqual(
      rejected ? [] : [expected],
    )
  },
)

test.each(['木造2階建', '土地', '店舗', '倉庫', '', '住宅・店舗'])(
  'residential eligibility remains quarantined for %s',
  async (構造) => {
    const { runtime } = open(() => csv([row({ 構造 })]))
    expect(await imported(runtime)).toMatchObject({
      counts: { added: 0, rejected: 1 },
    })
    expect(runtime.results(query).listings).toEqual([])
  },
)

test('refreshes changed prices, retains valid values on unknown checks, and only explicit contracted status hides an offer', async () => {
  let rows = [row()]
  const { runtime, requests } = open(() => csv(rows))
  await imported(runtime)
  const first = runtime.results(query).listings[0]
  rows = [row({ 金額: '2000000' })]
  expect(await imported(runtime)).toMatchObject({ counts: { updated: 1 } })
  expect(runtime.results(query).listings[0]).toMatchObject({
    id: first.id,
    salePriceJpy: 2000000,
  })
  rows = [row({ 金額: '', 受付状況: '不明' })]
  await imported(runtime)
  expect(runtime.results(query).listings[0]).toMatchObject({
    salePriceJpy: 2000000,
    availability: 'available',
  })
  rows = [row({ 受付状況: '成約済み' })]
  await imported(runtime)
  expect(
    runtime.results({ ...query, showUnavailable: false }).listings,
  ).toEqual([])
  const unavailable = runtime.results(query).listings[0]
  rows = []
  await imported(runtime)
  expect(runtime.results(query).listings[0]).toEqual(unavailable)
  rows = [row({ 構造: '木造' })]
  await imported(runtime)
  expect(runtime.results(query).listings[0]).toEqual(unavailable)
  expect(requests.every((url) => url === TSUBATA_EXPORT)).toBe(true)
  expect(runtime.results(query).municipalityGroups[0]).toMatchObject({
    representativePoint: null,
    count: 1,
  })
})

test('quarantines exact-witness rekeys and ID reassignment across imports, preserving the original offer', async () => {
  let rows = [row()]
  const { runtime } = open(() => csv(rows))
  await imported(runtime)
  const before = runtime.results(query).listings[0]
  rows = [row({ ID: 'TBB000000002' })]
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 0, rejected: 2 },
  })
  expect(runtime.results(query).listings[0]).toEqual(before)
  rows = [row({ 所在地_町字: '字変更' })]
  expect(await imported(runtime)).toMatchObject({
    counts: { updated: 0, rejected: 1 },
  })
  expect(runtime.results(query).listings[0]).toEqual(before)
})

test.each(
  [
    [row(), row()],
    [row(), row({ 金額: '2000000' })],
    [row({ 全国地方公共団体コード: '173615' })],
    [row({ ID: 'bad' })],
    [row({ 契約形態: '売買・賃貸' })],
    [row({ 契約形態: '賃貸', 金額: '42000', 備考: '' })],
  ].map((rows) => ({ rows })),
)(
  'ambiguous source-shaped identities and monthly units save nothing',
  async ({ rows }) => {
    const { runtime } = open(() => csv(rows))
    expect((await imported(runtime)).counts).toMatchObject({
      added: 0,
      rejected: rows.length,
    })
    expect(runtime.results(query).listings).toEqual([])
  },
)

test.each(['<html>blocked</html>', '"unterminated', 'x'.repeat(262145)])(
  'invalid export never establishes coverage or saved inventory',
  async (body) => {
    const { runtime, requests } = open(() => body)
    expect(await imported(runtime)).toMatchObject({
      state: 'failed',
      coverage: { status: 'partial' },
    })
    expect(runtime.results(query).listings).toEqual([])
    expect(requests).toEqual([TSUBATA_EXPORT])
  },
)

test('default adapter remains disabled without reviewed municipality intersection and makes no HTTP requests', async () => {
  const { runtime, requests } = open(() => csv([row()]), tsubataAdapter())
  expect(await imported(runtime)).toMatchObject({
    coverage: { status: 'partial' },
    counts: { added: 0 },
  })
  expect(requests).toEqual([])
})

test('CSV storage failure rolls back the observation and projection; retry preserves editorial state', async () => {
  let rows = [row()]
  const { runtime, path } = open(() => csv(rows))
  const db = new DatabaseSync(path)
  db.exec(
    "CREATE TRIGGER fail_save BEFORE INSERT ON listing_discovery_areas BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
  )
  expect(await imported(runtime)).toMatchObject({
    state: 'failed',
    counts: { checked: 0, added: 0 },
  })
  expect(runtime.results(query).listings).toEqual([])
  db.exec('DROP TRIGGER fail_save')
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 1, unchanged: 0 },
  })
  const first = runtime.results(query).listings[0]
  // Editorial state has no renderer operation: seed the private legacy state,
  // as in the existing storage regression, and ensure an adapter cannot erase it.
  db.prepare(
    "UPDATE listings SET data=json_set(data,'$.editorialStatus','hidden') WHERE id=?",
  ).run(first.id)
  rows = [
    row({
      金額: '2000000',
      備考: '電話 090-0000-0000; https://example.invalid/private.pdf',
    }),
  ]
  expect(await imported(runtime)).toMatchObject({ counts: { updated: 1 } })
  expect(runtime.results(query).listings[0]).toMatchObject({
    id: first.id,
    salePriceJpy: 2000000,
  })
  expect(
    JSON.parse(
      String(
        db.prepare('SELECT data FROM listings WHERE id=?').get(first.id)!.data,
      ),
    ).editorialStatus,
  ).toBe('hidden')
  expect(
    JSON.stringify(db.prepare('SELECT data FROM offer_observations').all()),
  ).not.toContain('090-0000')
  expect(JSON.stringify(runtime.results(query))).not.toContain(
    'editorialStatus',
  )
  db.close()
})

test('free rental still requires an evidenced monthly period', async () => {
  const { runtime } = open(() => csv([row({ 契約形態: '賃貸', 金額: '無料' })]))
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 0, rejected: 1 },
  })
})

test('a supported nonintersecting selection completes without fetching the municipal export', async () => {
  const { runtime, requests } = open(
    () => csv([row()]),
    tsubataAdapter({
      intersectsMunicipality: () => false,
      geographyVersion: 'synthetic-nonintersecting',
    }),
  )
  expect(await imported(runtime)).toMatchObject({
    state: 'succeeded',
    counts: { added: 0, checked: 0 },
    budget: { discoveryUsed: 0, detailUsed: 0 },
    coverage: { status: 'complete' },
  })
  expect(requests).toEqual([])
  expect(runtime.results(query).listings).toEqual([])
})

test('synthetic municipal intersection retains uncertain offers even when its representative lies outside the selection', async () => {
  // Authored circles exercise geographic gating without claiming real boundary evidence.
  const municipality = {
    center: { latitude: 35.06, longitude: 135 },
    radiusKm: 5,
  }
  const area = { center: { latitude: 35, longitude: 135 }, radiusKm: 2 }
  const representativePoint = { latitude: 35.1, longitude: 135 }
  const requests: string[] = []
  const runtime = new ImportRuntime(join(directory, `${++key}.sqlite`), 0, {
    ...testClock(),
    adapters: [
      tsubataAdapter({
        geographyVersion: 'fictional-circle-v1',
        intersectsMunicipality: (selection) =>
          areasIntersect(selection, municipality),
      }),
    ],
    municipalityReference: (id, selection) =>
      id === '173614' && areasIntersect(selection, municipality)
        ? {
            representativePoint,
            representativePointProvenance:
              'Authored fictional municipality reference, not a home',
          }
        : undefined,
    transport: async (url) => {
      requests.push(url)
      return { status: 200, body: csv([row()]) }
    },
  })
  runtimes.push(runtime)
  const request = runtime.createRequest({
    area,
    intent: 'import',
    idempotencyKey: String(++key),
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).stage)
    .toBe('finished')
  expect(runtime.inspect(request.jobIds[0])).toMatchObject({
    state: 'succeeded',
    coverage: { status: 'complete' },
    budget: { discoveryUsed: 1, detailUsed: 0 },
    counts: { checked: 1, added: 1 },
  })
  const results = runtime.results({ area, showUnavailable: true })
  expect(results.listings).toHaveLength(1)
  expect(results.listings[0].location).toEqual({
    kind: 'municipality',
    municipalityId: '173614',
  })
  expect(results.municipalityGroups).toEqual([
    expect.objectContaining({
      municipalityId: '173614',
      count: 1,
      representativePoint,
      representativePointProvenance:
        'Authored fictional municipality reference, not a home',
    }),
  ])
  expect(
    runtime.results({
      area: { center: { latitude: 34, longitude: 135 }, radiusKm: 2 },
      showUnavailable: true,
    }).listings,
  ).toEqual([])
  expect(requests).toEqual([TSUBATA_EXPORT])
})

test('complete header-only EOF is a successful empty export, not a failed acquisition', async () => {
  const { runtime, requests } = open(() => csv([]))
  expect(await imported(runtime)).toMatchObject({
    state: 'succeeded',
    coverage: { status: 'complete' },
    counts: { discovered: 0, checked: 0, added: 0 },
    budget: { discoveryUsed: 1, detailUsed: 0 },
  })
  expect(requests).toEqual([TSUBATA_EXPORT])
})

test('the acquisition row cap cannot certify traversal or save an export prefix', async () => {
  const { runtime, requests } = open(() =>
    csv(
      Array.from({ length: 1001 }, (_, i) =>
        row({
          ID: `TBB${String(i + 1).padStart(9, '0')}`,
          所在地_町字: `字試験${i}`,
        }),
      ),
    ),
  )
  expect(await imported(runtime)).toMatchObject({
    state: 'failed',
    error: { code: 'ROW_BUDGET_EXHAUSTED' },
    coverage: { status: 'partial', lastSuccessfulCheckAt: null },
    counts: { checked: 0, added: 0 },
  })
  expect(runtime.results(query).listings).toEqual([])
  expect(requests).toEqual([TSUBATA_EXPORT])
})

test('file dates and descending IDs cannot stop later export rows or advance date checkpoints', async () => {
  const path = join(directory, `${++key}.sqlite`)
  const requests: string[] = []
  let body = csv([row({ ID: 'TBB000000099' })])
  const runtime = new ImportRuntime(path, 0, {
    ...testClock(),
    adapters: [
      tsubataAdapter({
        geographyVersion: 'fictional-circle-v1',
        intersectsMunicipality: () => true,
      }),
    ],
    municipalityReference: (id) =>
      id === '173614'
        ? { representativePoint: null, representativePointProvenance: null }
        : undefined,
    areaFreshnessMs: 0,
    transport: async (url) => {
      requests.push(url)
      return {
        status: 200,
        headers: { 'Last-Modified': 'Wed, 14 Oct 2026 00:00:00 GMT' },
        body,
      }
    },
  })
  runtimes.push(runtime)
  const fault = new DatabaseSync(path)
  // A successful job must never attempt a date checkpoint for this undated CSV.
  fault.exec(
    "CREATE TRIGGER no_csv_dates BEFORE INSERT ON discovery_checkpoints BEGIN SELECT RAISE(ABORT,'CSV has no reliable offer dates'); END",
  )
  try {
    expect(await imported(runtime)).toMatchObject({
      state: 'succeeded',
      counts: { added: 1 },
    })
    body = csv([
      row({ ID: 'TBB000000099' }),
      row({ ID: 'TBB000000001', 所在地_町字: '字後行' }),
    ])
    expect(await imported(runtime)).toMatchObject({
      state: 'succeeded',
      counts: { discovered: 2, checked: 2, added: 1, unchanged: 1 },
    })
    expect(runtime.results(query).listings).toHaveLength(2)
    expect(requests).toEqual([TSUBATA_EXPORT, TSUBATA_EXPORT])
  } finally {
    fault.close()
  }
})
