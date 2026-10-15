import { expect, test } from 'vitest'
import { queryListings, safeSourceUrl } from './query'

test('returns verified inside and coincident offers but excludes outside and unavailable offers', async () => {
  const result = await queryListings({
    area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
    showUnavailable: false,
  })
  expect(result.mode).toBe('synthetic')
  expect(result.listings.map((listing) => listing.id)).toEqual([
    'sample-sale-1',
    'sample-rent-1',
    'sample-unknown-1',
  ])
})

test('includes a boundary offer and wraps longitude across the antimeridian', async () => {
  const boundary = await queryListings({
    area: {
      center: { latitude: 0, longitude: 0.04496608029593653 },
      radiusKm: 5,
    },
    showUnavailable: false,
  })
  expect(boundary.listings.map((listing) => listing.id)).toEqual([
    'sample-boundary-1',
  ])
  const wrapped = await queryListings({
    area: { center: { latitude: 0, longitude: 179.99 }, radiusKm: 5 },
    showUnavailable: false,
  })
  expect(wrapped.listings.map((listing) => listing.id)).toEqual([
    'sample-antimeridian-1',
  ])
})

test('only explicit unavailability is hidden and Show unavailable preserves offer identities', async () => {
  const result = await queryListings({
    area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
    showUnavailable: true,
  })
  expect(result.listings.map((listing) => listing.id)).toEqual([
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
    ).rejects.toThrow('Choose finite')
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

test.each(['http', 'https'])(
  'allows %s links on the configured source host',
  (scheme) => {
    const url = `${scheme}://example.invalid/offers/sale-1`
    expect(safeSourceUrl('fixture', url)).toBe(url)
  },
)

test.each([
  ['fixture', 'javascript:alert(1)'],
  ['fixture', 'ftp://example.invalid/offers/sale-1'],
  ['fixture', 'https://other.invalid/offers/sale-1'],
  ['fixture', 'https://example.invalid.attacker.invalid/offers/sale-1'],
  ['fixture', 'https://user:pass@example.invalid/offers/sale-1'],
  ['fixture', 'https://user@example.invalid/offers/sale-1'],
  ['fixture', 'https://:pass@example.invalid/offers/sale-1'],
  ['fixture', 'not a URL'],
  ['unknown-source', 'https://example.invalid/offers/sale-1'],
])('rejects unsafe or unconfigured source URL %s %s', (sourceId, url) => {
  expect(safeSourceUrl(sourceId, url)).toBeNull()
})
