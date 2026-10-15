import type { ListingProjection, Point } from '../shared/listings'

const checked = '2026-10-15T00:00:00Z'

function fixture(
  id: string,
  titleJa: string,
  point: Point,
  values: Partial<ListingProjection> = {},
): ListingProjection {
  const externalId = id.replace('sample-', '')
  const url = `https://example.invalid/offers/${externalId}`
  return {
    id,
    titleJa,
    sourceRefs: [
      { sourceId: 'fixture', externalId, name: 'Sample source', url },
    ],
    primarySourceUrl: url,
    transactionType: 'sale',
    salePriceJpy: 0,
    rentMonthlyJpy: null,
    priceNoteJa: null,
    propertyType: null,
    floorAreaM2: null,
    landAreaM2: null,
    prefecture: null,
    municipalityId: null,
    municipalityNameJa: null,
    availability: 'unknown',
    location: {
      kind: 'verified',
      point,
      evidence: 'synthetic verification',
      verifiedAt: checked,
    },
    firstSeenAt: checked,
    lastSeenAt: checked,
    sourceCheckedAt: checked,
    ...values,
  }
}

// Synthetic offers only. Separate sale and rental identities deliberately coincide.
export const fixtures = [
  fixture('sample-sale-1', 'サンプル売却情報', {
    latitude: 35,
    longitude: 135,
  }),
  fixture(
    'sample-rent-1',
    'サンプル賃貸情報',
    { latitude: 35, longitude: 135 },
    { transactionType: 'rent', salePriceJpy: null, rentMonthlyJpy: 35000 },
  ),
  fixture(
    'sample-unknown-1',
    '価格未定のサンプル',
    { latitude: 35.001, longitude: 135 },
    { salePriceJpy: null },
  ),
  fixture(
    'sample-unavailable-1',
    '募集終了のサンプル',
    { latitude: 35.002, longitude: 135 },
    { availability: 'unavailable', salePriceJpy: 5000000 },
  ),
  fixture('sample-outside-1', '範囲外サンプル', {
    latitude: 36,
    longitude: 135,
  }),
  fixture('sample-antimeridian-1', '日付変更線サンプル', {
    latitude: 0,
    longitude: -179.99,
  }),
  fixture('sample-boundary-1', '境界サンプル', { latitude: 0, longitude: 0 }),
]

// Published source points are candidate coordinates, never verified locations.
export const uncertainFixtures: ListingProjection[] = [
  fixture(
    'sample-unverified-1',
    '位置未確認サンプル',
    { latitude: 35.005, longitude: 135 },
    {
      location: {
        kind: 'unverified',
        point: { latitude: 35.005, longitude: 135 },
        precision: 'unknown',
        sourceId: 'fixture',
      },
    },
  ),
  fixture(
    'sample-approximate-1',
    '概略位置サンプル',
    { latitude: 35.005, longitude: 135 },
    {
      location: {
        kind: 'unverified',
        point: { latitude: 35.005, longitude: 135 },
        precision: 'approximate',
        sourceId: 'fixture',
      },
    },
  ),
  fixture(
    'sample-unverified-unavailable-1',
    '募集終了の位置未確認サンプル',
    { latitude: 35.006, longitude: 135 },
    {
      availability: 'unavailable',
      location: {
        kind: 'unverified',
        point: { latitude: 35.006, longitude: 135 },
        precision: 'unknown',
        sourceId: 'fixture',
      },
    },
  ),
]
