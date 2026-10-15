import type {
  AreaQuery,
  AreaResults,
  ListingProjection,
  Point,
  SelectedArea,
} from './contracts'

export const initialArea: SelectedArea = {
  center: { latitude: 35, longitude: 135 },
  radiusKm: 5,
}
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
const fixtures = [
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function numberBetween(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  )
}
export function isSelectedArea(value: unknown): value is SelectedArea {
  return (
    record(value) &&
    record(value.center) &&
    numberBetween(value.center.latitude, -90, 90) &&
    numberBetween(value.center.longitude, -180, 180) &&
    numberBetween(value.radiusKm, 0, 10) &&
    value.radiusKm > 0
  )
}

// Shortest great-circle geodesic, metres, mean Earth radius (Leaflet convention).
export function distanceMetres(a: Point, b: Point): number {
  const radians = Math.PI / 180
  const latitudeDelta = (b.latitude - a.latitude) * radians
  const longitudeDelta = (b.longitude - a.longitude) * radians
  const h =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(a.latitude * radians) *
      Math.cos(b.latitude * radians) *
      Math.sin(longitudeDelta / 2) ** 2
  return (
    6371000 *
    2 *
    Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)))
  )
}

export async function queryListings(query: AreaQuery): Promise<AreaResults> {
  if (
    !record(query) ||
    !isSelectedArea(query.area) ||
    typeof query.showUnavailable !== 'boolean'
  )
    throw new Error(
      'Choose finite latitude [-90, 90], longitude [-180, 180], and radius greater than 0 and at most 10 km.',
    )
  const area = structuredClone(query.area)
  return {
    area,
    showUnavailable: query.showUnavailable,
    mode: 'synthetic',
    listings: structuredClone(
      fixtures.filter(
        (listing) =>
          (query.showUnavailable || listing.availability !== 'unavailable') &&
          listing.location.kind === 'verified' &&
          distanceMetres(area.center, listing.location.point) <=
            area.radiusKm * 1000 + 1e-8,
      ),
    ),
    municipalityGroups: [],
    coverage: {
      status: 'unknown',
      lastSuccessfulCheckAt: null,
      freshUntil: null,
      scopeKey: null,
      caveats: [
        'Synthetic fixtures only; no real inventory or source coverage.',
      ],
    },
    generatedAt: checked,
  }
}

const sourceHosts: Record<string, string> = { fixture: 'example.invalid' }
export function safeSourceUrl(sourceId: string, value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname === sourceHosts[sourceId] &&
      !url.username &&
      !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
