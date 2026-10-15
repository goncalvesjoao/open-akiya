// @vitest-environment node
import { expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { fixtures, uncertainFixtures } from './fixtures'
import { initialArea } from '../shared/geography'
import type { AreaQuery } from '../shared/listings'
let runtime: ImportRuntime
beforeEach(async () => {
  runtime = new ImportRuntime(':memory:', 0, {
    adapters: [syntheticAdapter(0, fixtures)],
  })
  for (const area of [
    initialArea,
    { center: { latitude: 0, longitude: 179.99 }, radiusKm: 5 },
    { center: { latitude: 0, longitude: 0 }, radiusKm: 5 },
  ]) {
    const request = runtime.createRequest({
      area,
      intent: 'import',
      idempotencyKey: JSON.stringify(area),
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).state)
      .toBe('succeeded')
  }
})
afterEach(async () => {
  await runtime.close()
})
async function queryListings(query: AreaQuery) {
  return runtime.results(query)
}

test('returns verified inside and coincident offers but excludes outside and unavailable offers', async () => {
  const result = await queryListings({
    area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
    showUnavailable: false,
  })
  expect(result.mode).toBe('synthetic')
  expect(
    result.listings.map(
      (listing) => `sample-${listing.sourceRefs[0].externalId}`,
    ),
  ).toEqual(['sample-sale-1', 'sample-rent-1', 'sample-unknown-1'])
})

test('includes a boundary offer and wraps longitude across the antimeridian', async () => {
  const boundary = await queryListings({
    area: {
      center: { latitude: 0, longitude: 0.04496608029593653 },
      radiusKm: 5,
    },
    showUnavailable: false,
  })
  expect(
    boundary.listings.map(
      (listing) => `sample-${listing.sourceRefs[0].externalId}`,
    ),
  ).toEqual(['sample-boundary-1'])
  const wrapped = await queryListings({
    area: { center: { latitude: 0, longitude: 179.99 }, radiusKm: 5 },
    showUnavailable: false,
  })
  expect(
    wrapped.listings.map(
      (listing) => `sample-${listing.sourceRefs[0].externalId}`,
    ),
  ).toEqual(['sample-antimeridian-1'])
})

test('only explicit unavailability is hidden and Show unavailable preserves offer identities', async () => {
  const result = await queryListings({
    area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
    showUnavailable: true,
  })
  expect(
    result.listings.map(
      (listing) => `sample-${listing.sourceRefs[0].externalId}`,
    ),
  ).toEqual([
    'sample-sale-1',
    'sample-rent-1',
    'sample-unknown-1',
    'sample-unavailable-1',
  ])
  expect(result.listings[0].availability).toBe('unknown')
})

for (const area of [
  null,
  {},
  { center: null, radiusKm: 5 },
  { center: { latitude: '35', longitude: 135 }, radiusKm: 5 },
  ...[0, -1, 10.01, Infinity, NaN, '5', null].map((radiusKm) => ({
    center: { latitude: 35, longitude: 135 },
    radiusKm,
  })),
  ...[91, -91, Infinity, NaN, null].map((latitude) => ({
    center: { latitude, longitude: 135 },
    radiusKm: 5,
  })),
  ...[181, -181, Infinity, NaN, null].map((longitude) => ({
    center: { latitude: 35, longitude },
    radiusKm: 5,
  })),
]) {
  test(`rejects invalid boundary input ${JSON.stringify(area)}`, async () => {
    // Deliberately send untrusted JSON-shaped values across the public boundary.
    await expect(
      // @ts-expect-error boundary validation is required even for non-TypeScript clients
      queryListings({ area, showUnavailable: false }),
    ).rejects.toThrow('Invalid area query')
  })
}

test('rejects missing query members, nulls, numeric strings and non-boolean availability', async () => {
  for (const input of [
    null,
    {},
    {
      area: { center: { latitude: 35, longitude: 135 }, radiusKm: '5' },
      showUnavailable: false,
    },
    {
      area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
      showUnavailable: 'false',
    },
  ]) {
    // @ts-expect-error deliberately exercise the untrusted boundary
    await expect(queryListings(input)).rejects.toThrow()
  }
})

test('accepts WGS84 extremes and the maximum radius without clamping', async () => {
  for (const center of [
    { latitude: 90, longitude: 180 },
    { latitude: -90, longitude: -180 },
  ]) {
    const area = { center, radiusKm: 10 }
    const result = await queryListings({ area, showUnavailable: false })
    expect(result.area).toEqual(area)
    expect(result.listings).toEqual([])
  }
})

test('returns both uncertain source-point variants as candidates without claiming true radius membership', async () => {
  const uncertain = uncertainFixtures.slice(0, 2)
  const local = new ImportRuntime(':memory:', 0, {
    adapters: [syntheticAdapter(0, uncertain)],
  })
  try {
    const request = local.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'uncertain',
    })
    await expect
      .poll(() => local.inspect(request.jobIds[0]).state)
      .toBe('succeeded')
    expect(
      local
        .results({ area: initialArea, showUnavailable: false })
        .listings.map((listing) => listing.sourceRefs[0].externalId),
    ).toEqual(['unverified-1', 'approximate-1'])
    expect(
      local.results({
        area: { center: { latitude: 36, longitude: 135 }, radiusKm: 5 },
        showUnavailable: false,
      }).listings,
    ).toEqual([])
  } finally {
    await local.close()
  }
})

test('returns only unknown candidates with saved intersecting discovery evidence and respects precise outside positions', async () => {
  const { unknownFixtures } = await import('./fixtures')
  const directory = mkdtempSync(join(tmpdir(), 'akiya-unknown-query-'))
  const database = join(directory, 'listings.sqlite')
  let local = new ImportRuntime(database, 0, {
    adapters: [syntheticAdapter(0, unknownFixtures)],
  })
  try {
    for (const [key, area] of [
      ['near', initialArea],
      ['far', { center: { latitude: 36, longitude: 135 }, radiusKm: 5 }],
    ] as const) {
      const request = local.createRequest({
        area,
        intent: 'import',
        idempotencyKey: key,
      })
      await expect
        .poll(() => local.inspect(request.jobIds[0]).state)
        .toBe('succeeded')
    }
    await local.close()
    local = new ImportRuntime(database, 0, {
      adapters: [syntheticAdapter(0, unknownFixtures)],
    })
    // The precise outside listing was saved, but its broad discovery scope
    // must not put it in the near-area unknown candidates.
    expect(
      local
        .results({
          area: { center: { latitude: 36, longitude: 135 }, radiusKm: 1 },
          showUnavailable: false,
        })
        .listings.map((listing) => listing.sourceRefs[0].externalId),
    ).toContain('precise-outside-1')
    const query = {
      area: { center: { latitude: 35.05, longitude: 135 }, radiusKm: 1 },
      showUnavailable: false,
    }
    const result = local.results(query)
    expect(
      result.listings.map((listing) => listing.sourceRefs[0].externalId),
    ).toEqual(['location-unknown-1'])
    expect(result.listings[0].location).toEqual({ kind: 'unknown' })
    expect(
      local
        .results({ ...query, showUnavailable: true })
        .listings.map((listing) => listing.sourceRefs[0].externalId),
    ).toEqual(['location-unknown-1', 'location-unknown-unavailable-1'])
    expect(
      local.results({
        area: { center: { latitude: 34, longitude: 135 }, radiusKm: 1 },
        showUnavailable: true,
      }).listings,
    ).toEqual([])
  } finally {
    await local.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  {},
  { evidence: '', verifiedAt: '2026-10-15T00:00:00.000Z' },
  { evidence: '   ', verifiedAt: '2026-10-15T00:00:00.000Z' },
  { evidence: 'Historical position', verifiedAt: 'invalid' },
])(
  'reads legacy coordinates without valid verification evidence as unverified source points (%j)',
  async (verification) => {
    const { DatabaseSync } = await import('node:sqlite')
    const directory = mkdtempSync(join(tmpdir(), 'akiya-legacy-location-'))
    const path = join(directory, 'listings.sqlite')
    const setup = new ImportRuntime(path)
    await setup.close()
    const database = new DatabaseSync(path)
    // Historical records can claim verified while lacking the evidence now
    // required by the DTO. Seed persistence, observe only the public worker API.
    const legacy = {
      ...fixtures[0],
      location: {
        kind: 'verified',
        point: { latitude: 35, longitude: 135 },
        ...verification,
      },
    }
    database
      .prepare('INSERT INTO listings VALUES (?,?,?,?)')
      .run(legacy.id, 'fixture', 'legacy', JSON.stringify(legacy))
    database.close()
    const local = new ImportRuntime(path)
    try {
      expect(
        local.results({ area: initialArea, showUnavailable: false }).listings[0]
          .location,
      ).toEqual({
        kind: 'unverified',
        point: { latitude: 35, longitude: 135 },
        precision: 'unknown',
        sourceId: 'fixture',
      })
    } finally {
      await local.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test('independent saved-area queries preserve check times and never collect or fabricate coverage', async () => {
  let requests = 0
  let now = Date.parse('2026-10-15T00:00:00.000Z')
  const base = syntheticAdapter(0, fixtures)
  const local = new ImportRuntime(':memory:', 0, {
    now: () => now,
    adapters: [
      {
        ...base,
        async discover(input, context) {
          requests++
          return base.discover(input, context)
        },
        async fetchDetail(candidate, context) {
          requests++
          return base.fetchDetail(candidate, context)
        },
      },
    ],
  })
  try {
    const request = local.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'read-only',
    })
    await expect
      .poll(() => local.inspect(request.jobIds[0]).state)
      .toBe('succeeded')
    const beforeRequests = requests
    const budget = local.inspect(request.jobIds[0]).budget
    now = Date.parse('2026-10-16T00:00:00.000Z')
    const result = local.results({
      area: { center: { latitude: 35, longitude: 135 }, radiusKm: 1 },
      showUnavailable: false,
    })
    expect(result.area.radiusKm).toBe(1)
    expect(
      result.listings.map((listing) => listing.sourceRefs[0].externalId),
    ).toEqual(['sale-1', 'rent-1', 'unknown-1'])
    expect(result.listings.map((listing) => listing.sourceCheckedAt)).toEqual([
      '2026-10-15T00:00:00.000Z',
      '2026-10-15T00:00:00.000Z',
      '2026-10-15T00:00:00.000Z',
    ])
    expect(result.coverage).toMatchObject({
      status: 'unknown',
      lastSuccessfulCheckAt: null,
      freshUntil: null,
      scopeKey: null,
    })
    expect(result.generatedAt).toBe('2026-10-16T00:00:00.000Z')
    expect(
      local.results({
        area: { center: { latitude: 36, longitude: 135 }, radiusKm: 1 },
        showUnavailable: false,
      }).listings,
    ).toEqual([])
    expect(requests).toBe(beforeRequests)
    expect(local.inspect(request.jobIds[0]).budget).toEqual(budget)
  } finally {
    await local.close()
  }
})
