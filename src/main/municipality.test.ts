// @vitest-environment node
import { expect, test } from 'vitest'
import { ImportRuntime } from './runtime'
import { testClock } from './test-clock'
import { syntheticAdapter } from './adapter'
import { fixtures } from './fixtures'
import { initialArea } from '../shared/geography'

test('includes intersecting municipality offers independently of their representative point and filters counts before grouping', async () => {
  const offers = [
    'municipality-1',
    'municipality-unavailable-1',
    'municipality-no-point-1',
  ].map((externalId, index) => ({
    ...fixtures[0],
    id: `sample-${externalId}`,
    sourceRefs: [
      {
        ...fixtures[0].sourceRefs[0],
        externalId,
        url: `https://example.invalid/offers/${externalId}`,
      },
    ],
    primarySourceUrl: `https://example.invalid/offers/${externalId}`,
    municipalityId:
      index === 2 ? 'fixture:municipality-2' : 'fixture:municipality-1',
    municipalityNameJa: 'サンプル自治体',
    availability: index === 1 ? ('unavailable' as const) : ('unknown' as const),
    location: {
      kind: 'municipality' as const,
      municipalityId:
        index === 2 ? 'fixture:municipality-2' : 'fixture:municipality-1',
    },
  }))
  const runtime = new ImportRuntime(':memory:', 0, {
    ...testClock(),
    adapters: [syntheticAdapter(0, offers)],
  })
  try {
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'municipalities',
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).state)
      .toBe('succeeded')
    const result = runtime.results({
      area: initialArea,
      showUnavailable: false,
    })
    expect(
      result.municipalityGroups.map((group) => ({
        ...group,
        listingIds: group.listingIds.map(
          (id) =>
            result.listings.find((listing) => listing.id === id)?.sourceRefs[0]
              .externalId,
        ),
      })),
    ).toEqual([
      {
        municipalityId: 'fixture:municipality-1',
        nameJa: 'サンプル自治体',
        listingIds: ['municipality-1'],
        count: 1,
        representativePoint: { latitude: 35.1, longitude: 135 },
        representativePointProvenance:
          'Synthetic municipal office; fictional reference circle centered at 35.06, 135 with radius 5 km',
      },
      {
        municipalityId: 'fixture:municipality-2',
        nameJa: 'サンプル自治体',
        listingIds: ['municipality-no-point-1'],
        count: 1,
        representativePoint: null,
        representativePointProvenance: null,
      },
    ])
    expect(result.listings).toHaveLength(2)
    expect(
      runtime
        .results({ area: initialArea, showUnavailable: true })
        .municipalityGroups.map((group) => group.count),
    ).toEqual([2, 1])
    expect(
      runtime.results({
        area: { center: { latitude: 36, longitude: 135 }, radiusKm: 5 },
        showUnavailable: true,
      }).listings,
    ).toEqual([])
  } finally {
    await runtime.close()
  }
})

test('routes a source point documented as a municipal office into its municipality instead of an individual pin', async () => {
  const { municipalityFixtures } = await import('./fixtures')
  const offer = municipalityFixtures.find(
    (offer) => offer.sourceRefs[0].externalId === 'municipality-source-point-1',
  )!
  expect(offer.location.kind).toBe('unverified')
  const runtime = new ImportRuntime(':memory:', 0, {
    ...testClock(),
    adapters: [syntheticAdapter(0, [offer])],
  })
  try {
    const request = runtime.createRequest({
      area: initialArea,
      intent: 'import',
      idempotencyKey: 'source-municipality',
    })
    await expect
      .poll(() => runtime.inspect(request.jobIds[0]).state)
      .toBe('succeeded')
    const result = runtime.results({
      area: initialArea,
      showUnavailable: false,
    })
    expect(result.listings[0]?.location).toEqual({
      kind: 'municipality',
      municipalityId: 'fixture:municipality-1',
    })
    expect(result.municipalityGroups[0]?.count).toBe(1)
  } finally {
    await runtime.close()
  }
})
