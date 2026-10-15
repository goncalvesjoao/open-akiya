// @vitest-environment node
import { expect, test, beforeEach, afterEach } from 'vitest'
import { ImportRuntime } from './runtime'
import { syntheticAdapter } from './adapter'
import { fixtures } from './fixtures'
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
