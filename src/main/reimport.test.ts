// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter, type SourceAdapter } from './adapter'
import { fixtures } from './fixtures'
import { initialArea } from '../shared/geography'

const directory = mkdtempSync(join(tmpdir(), 'akiya-reimport-'))
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
const query = { area: initialArea, showUnavailable: true }
let key = 0
async function imported(runtime: ImportRuntime) {
  const request = runtime.createRequest({
    area: initialArea,
    intent: 'import',
    idempotencyKey: String(++key),
  })
  await expect
    .poll(() => runtime.inspect(request.jobIds[0]).state)
    .not.toMatch(/queued|running/)
  return runtime.inspect(request.jobIds[0])
}
function open(name: string, adapters: SourceAdapter[]) {
  const runtime = new ImportRuntime(join(directory, name), 1, { adapters })
  runtimes.push(runtime)
  return runtime
}

test('provider-scoped sale and rental offers sharing native identity and URL remain distinct and replay once', async () => {
  const sale = fixtures[0]
  const rent = {
    ...sale,
    transactionType: 'rent' as const,
    salePriceJpy: null,
    rentMonthlyJpy: 42000,
    floorAreaM2: 25.5,
  }
  const runtime = open('variants.sqlite', [syntheticAdapter(1, [sale, rent])])
  expect(await imported(runtime)).toMatchObject({
    state: 'succeeded',
    counts: { discovered: 2, checked: 2, added: 2 },
  })
  expect(runtime.results(query).listings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ transactionType: 'sale', salePriceJpy: 0 }),
      expect.objectContaining({
        transactionType: 'rent',
        rentMonthlyJpy: 42000,
        floorAreaM2: 25.5,
      }),
    ]),
  )
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 0, unchanged: 2 },
  })
})

test('partial checks preserve valid fields and only evidenced explicit removals clear them', async () => {
  const base = syntheticAdapter(1)
  let patch = 0
  const adapter: SourceAdapter = {
    ...base,
    normalize(evidence) {
      const result = base.normalize(evidence)
      if (result.kind === 'accepted' && patch) {
        result.observation.fields = {
          titleJa: '変更済み',
          salePriceJpy: null,
          floorAreaM2: null,
        }
        if (patch === 2)
          result.observation.provenance = {
            salePriceJpy: 'Source explicitly removed the price',
          }
      }
      return result
    },
  }
  const runtime = open('patch.sqlite', [adapter])
  await imported(runtime)
  const first = runtime.results(query).listings[0]
  patch = 1
  expect(await imported(runtime)).toMatchObject({ counts: { updated: 1 } })
  expect(runtime.results(query).listings[0]).toMatchObject({
    id: first.id,
    titleJa: '変更済み',
    salePriceJpy: 0,
    floorAreaM2: first.floorAreaM2,
    primarySourceUrl: first.primarySourceUrl,
  })
  expect(await imported(runtime)).toMatchObject({
    counts: { unchanged: 1, updated: 0 },
  })
  patch = 2
  expect(await imported(runtime)).toMatchObject({ counts: { updated: 1 } })
  expect(runtime.results(query).listings[0].salePriceJpy).toBeNull()
})

test('failed storage rolls back observation, listing and all outcome counts together', async () => {
  const runtime = open('rollback.sqlite', [syntheticAdapter(1)])
  const db = new DatabaseSync(join(directory, 'rollback.sqlite'))
  db.exec(
    "CREATE TRIGGER fail_save BEFORE INSERT ON listing_discovery_areas BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
  )
  expect(await imported(runtime)).toMatchObject({
    state: 'failed',
    counts: { checked: 0, added: 0, updated: 0, unchanged: 0 },
  })
  expect(runtime.results(query).listings).toEqual([])
  db.exec('DROP TRIGGER fail_save')
  expect(await imported(runtime)).toMatchObject({
    state: 'succeeded',
    counts: { added: 1, unchanged: 0 },
  })
  db.close()
})

test('explicit unavailability is retained while failed checks and scoped absence never withdraw other source offers', async () => {
  let phase = 0
  const base = syntheticAdapter(1)
  const otherOffer = {
    ...fixtures[0],
    sourceRefs: [{ ...fixtures[0].sourceRefs[0], sourceId: 'other' }],
  }
  const other = syntheticAdapter(1, [otherOffer])
  const adapter: SourceAdapter = {
    ...base,
    async discover(input, context) {
      const page = await base.discover(input, context)
      return phase === 3 ? { ...page, candidates: [] } : page
    },
    normalize(evidence) {
      if (phase === 2)
        return {
          kind: 'rejected',
          error: {
            code: 'PARSE_ERROR',
            message: 'Synthetic parse failure',
            retryable: false,
          },
        }
      const result = base.normalize(evidence)
      if (result.kind === 'accepted')
        result.observation.fields.availability =
          phase === 1 ? 'unavailable' : 'available'
      return result
    },
  }
  const runtime = open('availability.sqlite', [adapter, other])
  expect(await imported(runtime)).toMatchObject({ counts: { added: 2 } })
  expect(runtime.results(query).listings).toHaveLength(2)
  phase = 1
  expect(await imported(runtime)).toMatchObject({
    counts: { updated: 1, unchanged: 1 },
  })
  expect(
    runtime.results({ ...query, showUnavailable: false }).listings,
  ).toHaveLength(1)
  const checked = runtime
    .results(query)
    .listings.find((l) => l.availability === 'unavailable')!.sourceCheckedAt
  phase = 2
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { rejected: 1, unchanged: 1 },
  })
  expect(
    runtime
      .results(query)
      .listings.find((l) => l.availability === 'unavailable')!.sourceCheckedAt,
  ).toBe(checked)
  phase = 3
  await imported(runtime)
  expect(runtime.results(query).listings).toHaveLength(2)
})

test('additive migration preserves legacy UUID, Japanese originals, attribution, unknown timestamps and editorial decisions', async () => {
  const path = join(directory, 'legacy.sqlite')
  const db = new DatabaseSync(path)
  const legacy = {
    ...fixtures[0],
    id: 'legacy-uuid',
    firstSeenAt: null,
    lastSeenAt: null,
    sourceCheckedAt: null,
    editorialStatus: 'hidden',
    originalJapanese: '原文保持',
    salePriceJpy: 1234567,
    sourceRefs: [
      { ...fixtures[0].sourceRefs[0], name: 'Original attribution' },
    ],
  }
  db.exec(
    'CREATE TABLE listings (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(source_id,external_id))',
  )
  db.prepare('INSERT INTO listings VALUES (?,?,?,?)').run(
    legacy.id,
    'fixture',
    'sale-1',
    JSON.stringify(legacy),
  )
  const base = syntheticAdapter(1)
  const adapter: SourceAdapter = {
    ...base,
    normalize(evidence) {
      const result = base.normalize(evidence)
      if (result.kind === 'accepted')
        result.observation.fields = { titleJa: legacy.titleJa }
      return result
    },
  }
  const runtime = open('legacy.sqlite', [adapter])
  expect(runtime.results(query).listings[0]).toMatchObject({
    id: 'legacy-uuid',
    sourceCheckedAt: null,
    lastSeenAt: null,
    firstSeenAt: null,
    salePriceJpy: 1234567,
  })
  expect(await imported(runtime)).toMatchObject({
    counts: { unchanged: 1, added: 0 },
  })
  expect(runtime.results(query).listings[0]).toMatchObject({
    id: 'legacy-uuid',
    firstSeenAt: null,
    salePriceJpy: 1234567,
    sourceRefs: [{ name: 'Original attribution' }],
  })
  // Editorial/private originals deliberately have no renderer DTO; inspect the saved
  // legacy record to verify migration retention without adding an exposure API.
  expect(
    JSON.parse(
      String(
        db.prepare('SELECT data FROM listings WHERE id=?').get(legacy.id)!.data,
      ),
    ),
  ).toMatchObject({ editorialStatus: 'hidden', originalJapanese: '原文保持' })
  db.close()
})

test.each([-1, 1.25, Number.MAX_SAFE_INTEGER + 1, Infinity, '500'])(
  'unsafe money %s cannot replace a saved valid price',
  async (value) => {
    let invalid = false
    const base = syntheticAdapter(1)
    const adapter: SourceAdapter = {
      ...base,
      normalize(evidence) {
        const result = base.normalize(evidence)
        if (result.kind === 'accepted' && invalid)
          Object.assign(result.observation.fields, { salePriceJpy: value })
        return result
      },
    }
    const runtime = open(`money-${++key}.sqlite`, [adapter])
    await imported(runtime)
    const before = runtime.results(query).listings[0]
    invalid = true
    expect(await imported(runtime)).toMatchObject({
      state: 'partial',
      counts: { checked: 1, rejected: 1, updated: 0 },
    })
    expect(runtime.results(query).listings[0]).toEqual(before)
  },
)

test('missing availability and location evidence cannot resurrect a withdrawn offer or erase its position', async () => {
  let incomplete = false
  const base = syntheticAdapter(1)
  const adapter: SourceAdapter = {
    ...base,
    normalize(evidence) {
      const result = base.normalize(evidence)
      if (result.kind === 'accepted') {
        result.observation.fields.availability = incomplete
          ? 'unknown'
          : 'unavailable'
        if (incomplete) result.observation.fields.location = { kind: 'unknown' }
      }
      return result
    },
  }
  const runtime = open('no-evidence.sqlite', [adapter])
  await imported(runtime)
  incomplete = true
  expect(await imported(runtime)).toMatchObject({ counts: { unchanged: 1 } })
  expect(runtime.results(query).listings[0]).toMatchObject({
    availability: 'unavailable',
    location: { kind: 'verified' },
  })
  expect(
    runtime.results({ ...query, showUnavailable: false }).listings,
  ).toEqual([])
})

test('retains unknown money separately from explicit zero sale and monthly rent', async () => {
  const runtime = open('money-values.sqlite', [
    syntheticAdapter(1, [
      fixtures[0],
      { ...fixtures[1], rentMonthlyJpy: 0 },
      fixtures[2],
    ]),
  ])
  expect(await imported(runtime)).toMatchObject({
    counts: { added: 3, rejected: 0 },
  })
  expect(runtime.results(query).listings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ transactionType: 'sale', salePriceJpy: 0 }),
      expect.objectContaining({
        transactionType: 'rent',
        rentMonthlyJpy: 0,
        salePriceJpy: null,
      }),
      expect.objectContaining({ salePriceJpy: null, rentMonthlyJpy: null }),
    ]),
  )
})

test.each([
  'titleJa',
  'priceNoteJa',
  'propertyType',
  'prefecture',
  'municipalityId',
  'municipalityNameJa',
] as const)(
  'blank %s patches cannot erase saved source text',
  async (field) => {
    const offer = {
      ...fixtures[0],
      titleJa: '元の見出し',
      priceNoteJa: '元の価格注記',
      propertyType: '元の物件種別',
      prefecture: '元の県名',
      municipalityId: 'fixture:original',
      municipalityNameJa: '元の自治体名',
    }
    let patch: string | undefined
    const base = syntheticAdapter(1, [offer])
    const adapter: SourceAdapter = {
      ...base,
      normalize(evidence) {
        const result = base.normalize(evidence)
        if (result.kind === 'accepted' && patch !== undefined)
          result.observation.fields[field] = patch
        return result
      },
    }
    const runtime = open(`blank-${field}.sqlite`, [adapter])
    await imported(runtime)
    const saved = runtime.results(query).listings[0]
    for (const blank of ['', ' \t\n　']) {
      patch = blank
      expect(await imported(runtime)).toMatchObject({
        state: 'partial',
        counts: { checked: 1, rejected: 1, updated: 0 },
      })
      expect(runtime.results(query).listings[0]).toEqual(saved)
    }
  },
)
