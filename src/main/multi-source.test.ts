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

const directory = mkdtempSync(join(tmpdir(), 'akiya-multi-source-'))
const runtimes: ImportRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
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
const query = { area: initialArea, showUnavailable: true }

function adapters(state: { phase: number }): SourceAdapter[] {
  return ['fixture', 'secondary'].map((sourceId, index) => {
    const offer = {
      ...fixtures[0],
      titleJa: index ? 'Secondary title' : fixtures[0].titleJa,
      availability: 'available' as const,
      sourceRefs: [
        {
          ...fixtures[0].sourceRefs[0],
          sourceId,
          externalId: index ? 'duplicate' : 'sale-1',
        },
      ],
      primarySourceUrl: `https://example.invalid/${sourceId}`,
    }
    const base = syntheticAdapter(1, [offer])
    return {
      ...base,
      normalize(evidence) {
        if (state.phase === 2)
          return {
            kind: 'rejected',
            error: {
              code: 'PARSE_ERROR',
              message: 'Synthetic failure',
              retryable: false,
            },
          }
        const result = base.normalize(evidence)
        if (result.kind === 'accepted') {
          if (index)
            Object.assign(result.observation, {
              confirmedDuplicateOf: {
                sourceId: 'fixture',
                externalId: 'sale-1',
                evidence: 'Authored synthetic duplicate offer identity',
              },
            })
          result.observation.fields.availability =
            state.phase >= (index ? 3 : 1) ? 'unavailable' : 'available'
        }
        return result
      },
    }
  })
}

test('proven duplicate sources share one attributed projection with independent withdrawal and failed-check evidence', async () => {
  const state = { phase: 0 }
  let clock = Date.parse('2026-10-16T00:00:00Z')
  const runtime = new ImportRuntime(join(directory, 'duplicate.sqlite'), 1, {
    adapters: adapters(state),
    now: () => clock,
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'succeeded',
    counts: { added: 1 },
  })
  const first = runtime.results(query).listings
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({
    titleJa: fixtures[0].titleJa,
    primarySourceUrl: 'https://example.invalid/fixture',
    sourceRefs: [{ sourceId: 'fixture' }, { sourceId: 'secondary' }],
    availability: 'available',
    sourceCheckedAt: '2026-10-16T00:00:00.000Z',
  })
  state.phase = 1
  clock += 86400000
  await imported(runtime)
  expect(
    runtime.results({ ...query, showUnavailable: false }).listings,
  ).toHaveLength(1)
  expect(runtime.results(query).listings[0]).toMatchObject({
    id: first[0].id,
    availability: 'available',
  })
  const supported = runtime.results(query).listings[0]
  state.phase = 2
  clock += 86400000
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { rejected: 2 },
  })
  expect(runtime.results(query).listings[0]).toEqual(supported)
  state.phase = 3
  clock += 86400000
  await imported(runtime)
  expect(
    runtime.results({ ...query, showUnavailable: false }).listings,
  ).toEqual([])
  expect(runtime.results(query).listings[0]).toMatchObject({
    id: first[0].id,
    availability: 'unavailable',
    primarySourceUrl: first[0].primarySourceUrl,
  })
})

test('duplicate history remains private and failed imports append no successful evidence', async () => {
  const state = { phase: 0 }
  const path = join(directory, 'history.sqlite')
  const runtime = new ImportRuntime(path, 1, { adapters: adapters(state) })
  runtimes.push(runtime)
  await imported(runtime)
  const db = new DatabaseSync(path)
  try {
    expect(
      db
        .prepare('SELECT count(*) AS count FROM offer_observation_history')
        .get(),
    ).toMatchObject({ count: 2 })
    expect(
      db.prepare('SELECT count(*) AS count FROM offer_observations').get(),
    ).toMatchObject({ count: 2 })
    state.phase = 1
    await imported(runtime)
    expect(
      db
        .prepare('SELECT count(*) AS count FROM offer_observation_history')
        .get(),
    ).toMatchObject({ count: 4 })
    state.phase = 2
    await imported(runtime)
    expect(
      db
        .prepare('SELECT count(*) AS count FROM offer_observation_history')
        .get(),
    ).toMatchObject({ count: 4 })
    const response = JSON.stringify(runtime.results(query))
    expect(response).not.toMatch(
      /confirmedDuplicateOf|contentHash|adapterVersion|provenance/,
    )
    const observations = db
      .prepare('SELECT data FROM offer_observations ORDER BY source_id')
      .all()
      .map((row) => JSON.parse(String(row.data)))
    expect(observations).toMatchObject([
      { fields: { availability: 'unavailable' } },
      {
        fields: { availability: 'available' },
        confirmedDuplicateOf: {
          evidence: 'Authored synthetic duplicate offer identity',
        },
      },
    ])
  } finally {
    db.close()
  }
})

test.each([
  { sourceId: 'fixture', externalId: 'missing', evidence: 'Proven identity' },
  { sourceId: 'fixture', externalId: 'sale-1', evidence: '  ' },
  { sourceId: 'secondary', externalId: 'sale-1', evidence: 'Proven identity' },
])(
  'invalid duplicate claim %j cannot attach or save a reference',
  async (claim) => {
    const state = { phase: 0 }
    const sources = adapters(state)
    const base = sources[1]
    sources[1] = {
      ...base,
      normalize(evidence) {
        const result = base.normalize(evidence)
        if (result.kind === 'accepted')
          result.observation.confirmedDuplicateOf = claim
        return result
      },
    }
    const runtime = new ImportRuntime(
      join(directory, `invalid-${++key}.sqlite`),
      1,
      { adapters: sources },
    )
    runtimes.push(runtime)
    expect(await imported(runtime)).toMatchObject({
      state: 'partial',
      counts: { added: 1, rejected: 1 },
    })
    expect(runtime.results(query).listings[0].sourceRefs).toHaveLength(1)
  },
)

test('supporting source time stays conservative and proven links survive omitted claims across restart', async () => {
  const state = { phase: 0 }
  let claim = true
  const sources = adapters(state)
  const base = sources[1]
  sources[1] = {
    ...base,
    normalize(evidence) {
      const result = base.normalize(evidence)
      if (result.kind === 'accepted') {
        result.observation.sourceCheckedAt = '2026-10-15T00:00:00Z'
        if (!claim) delete result.observation.confirmedDuplicateOf
      }
      return result
    },
  }
  const path = join(directory, 'restart.sqlite')
  let runtime = new ImportRuntime(path, 1, {
    adapters: sources,
    now: () => Date.parse('2026-10-16T00:00:00Z'),
  })
  await imported(runtime)
  expect(runtime.results(query).listings[0].sourceCheckedAt).toBe(
    '2026-10-15T00:00:00Z',
  )
  await runtime.close()
  claim = false
  runtime = new ImportRuntime(path, 1, {
    adapters: sources,
    now: () => Date.parse('2026-10-17T00:00:00Z'),
  })
  runtimes.push(runtime)
  await imported(runtime)
  expect(runtime.results(query).listings).toHaveLength(1)
  expect(runtime.results(query).listings[0]).toMatchObject({
    sourceCheckedAt: '2026-10-15T00:00:00Z',
    firstSeenAt: '2026-10-16T00:00:00.000Z',
    primarySourceUrl: 'https://example.invalid/fixture',
  })
})

test('matching appearance without proof and a claimed sale/rental match stay separate', async () => {
  const state = { phase: 0 }
  const sources = adapters(state)
  const base = sources[1]
  sources[1] = {
    ...base,
    normalize(evidence) {
      const result = base.normalize(evidence)
      if (result.kind === 'accepted')
        delete result.observation.confirmedDuplicateOf
      return result
    },
  }
  const rental = {
    ...fixtures[0],
    transactionType: 'rent' as const,
    salePriceJpy: null,
    rentMonthlyJpy: 10000,
    sourceRefs: [{ ...fixtures[0].sourceRefs[0], sourceId: 'rental' }],
  }
  const rentBase = syntheticAdapter(1, [rental])
  sources.push({
    ...rentBase,
    normalize(evidence) {
      const result = rentBase.normalize(evidence)
      if (result.kind === 'accepted')
        result.observation.confirmedDuplicateOf = {
          sourceId: 'fixture',
          externalId: 'sale-1',
          evidence: 'Same property is not the same offer',
        }
      return result
    },
  })
  const runtime = new ImportRuntime(join(directory, 'separate.sqlite'), 1, {
    adapters: sources,
  })
  runtimes.push(runtime)
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { added: 2, rejected: 1 },
  })
  expect(runtime.results(query).listings).toHaveLength(2)
  for (const listing of runtime.results(query).listings)
    expect(listing.sourceRefs).toHaveLength(1)
})

test('a secondary successful check cannot freshen retained primary facts after primary failure', async () => {
  const state = { phase: 0 }
  const sources = adapters(state)
  let fail = false
  const primary = sources[0]
  sources[0] = {
    ...primary,
    normalize(evidence) {
      return fail
        ? {
            kind: 'rejected',
            error: {
              code: 'PARSE_ERROR',
              message: 'Synthetic failure',
              retryable: false,
            },
          }
        : primary.normalize(evidence)
    },
  }
  let clock = Date.parse('2026-10-16T00:00:00Z')
  const runtime = new ImportRuntime(
    join(directory, 'primary-failure.sqlite'),
    1,
    { adapters: sources, now: () => clock },
  )
  runtimes.push(runtime)
  await imported(runtime)
  state.phase = 1
  await imported(runtime)
  fail = true
  clock += 86400000
  await imported(runtime)
  expect(runtime.results(query).listings[0]).toMatchObject({
    availability: 'available',
    titleJa: fixtures[0].titleJa,
    sourceCheckedAt: '2026-10-16T00:00:00.000Z',
    lastSeenAt: '2026-10-16T00:00:00.000Z',
  })
})

test('an established duplicate cannot be relinked to another saved offer', async () => {
  const sources = adapters({ phase: 0 })
  const secondary = sources[1]
  let relink = false
  sources[1] = {
    ...secondary,
    normalize(evidence) {
      const result = secondary.normalize(evidence)
      if (result.kind === 'accepted' && relink)
        result.observation.confirmedDuplicateOf = {
          sourceId: 'independent',
          externalId: 'sale-1',
          evidence: 'Conflicting claim',
        }
      return result
    },
  }
  sources.push(
    syntheticAdapter(1, [
      {
        ...fixtures[0],
        sourceRefs: [{ ...fixtures[0].sourceRefs[0], sourceId: 'independent' }],
      },
    ]),
  )
  const runtime = new ImportRuntime(join(directory, 'relink.sqlite'), 1, {
    adapters: sources,
  })
  runtimes.push(runtime)
  await imported(runtime)
  const before = runtime.results(query).listings
  relink = true
  expect(await imported(runtime)).toMatchObject({
    state: 'partial',
    counts: { rejected: 1, added: 0 },
  })
  expect(
    runtime
      .results(query)
      .listings.map((listing) => ({
        id: listing.id,
        sourceRefs: listing.sourceRefs,
      })),
  ).toEqual(
    before.map((listing) => ({
      id: listing.id,
      sourceRefs: listing.sourceRefs,
    })),
  )
})
