export type Point = { latitude: number; longitude: number }
export type SelectedArea = { center: Point; radiusKm: number }
export type AreaQuery = { area: SelectedArea; showUnavailable: boolean }

export type SourceRef = {
  sourceId: string
  externalId: string
  name: string
  url: string
}
export type Location =
  | { kind: 'verified'; point: Point; evidence: string; verifiedAt: string }
  | {
      kind: 'unverified'
      point: Point
      precision: 'unknown' | 'approximate'
      sourceId: string
    }
  | { kind: 'municipality'; municipalityId: string }
  | { kind: 'unknown' }
export type ListingProjection = {
  id: string
  titleJa: string
  sourceRefs: SourceRef[]
  primarySourceUrl: string
  transactionType: 'sale' | 'rent' | 'both' | 'unknown'
  salePriceJpy: number | null
  rentMonthlyJpy: number | null
  priceNoteJa: string | null
  propertyType: string | null
  floorAreaM2: number | null
  landAreaM2: number | null
  prefecture: string | null
  municipalityId: string | null
  municipalityNameJa: string | null
  availability: 'available' | 'under_offer' | 'unavailable' | 'unknown'
  location: Location
  firstSeenAt: string | null
  lastSeenAt: string | null
  sourceCheckedAt: string | null
}
export type MunicipalityGroup = {
  municipalityId: string
  nameJa: string
  listingIds: string[]
  count: number
  representativePoint: Point | null
  representativePointProvenance: string | null
}
export type AreaResults = {
  area: SelectedArea
  showUnavailable: boolean
  mode: 'synthetic' | 'live'
  listings: ListingProjection[]
  municipalityGroups: MunicipalityGroup[]
  coverage: Coverage
  generatedAt: string
}

export type Coverage = {
  status: 'unknown' | 'partial' | 'complete'
  lastSuccessfulCheckAt: string | null
  freshUntil: string | null
  scopeKey: string | null
  caveats: string[]
}
