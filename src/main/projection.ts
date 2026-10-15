import type { ListingProjection, Location } from '../shared/listings'
import { invalid } from './errors'

function point(value: { latitude: number; longitude: number }) {
  if (
    !value ||
    !Number.isFinite(value.latitude) ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.latitude) > 90 ||
    Math.abs(value.longitude) > 180
  )
    invalid('Invalid source location')
  return { latitude: value.latitude, longitude: value.longitude }
}
function location(value: Location): Location {
  switch (value?.kind) {
    case 'verified':
      if (
        typeof value.evidence !== 'string' ||
        !Number.isFinite(Date.parse(value.verifiedAt))
      )
        invalid('Invalid source location')
      return {
        kind: 'verified',
        point: point(value.point),
        evidence: value.evidence,
        verifiedAt: value.verifiedAt,
      }
    case 'unverified':
      if (
        !['unknown', 'approximate'].includes(value.precision) ||
        typeof value.sourceId !== 'string'
      )
        invalid('Invalid source location')
      return {
        kind: 'unverified',
        point: point(value.point),
        precision: value.precision,
        sourceId: value.sourceId,
      }
    case 'municipality':
      if (typeof value.municipalityId !== 'string')
        invalid('Invalid source location')
      return { kind: 'municipality', municipalityId: value.municipalityId }
    case 'unknown':
      return { kind: 'unknown' }
    default:
      invalid('Invalid source location')
  }
}
// Deliberate field construction keeps private observation and legacy operational
// columns out of every saved-data response, including nested source/location data.
export function listingProjection(value: ListingProjection): ListingProjection {
  if (typeof value.titleJa !== 'string' || !value.titleJa)
    invalid('Invalid source title')
  for (const field of [
    value.priceNoteJa,
    value.propertyType,
    value.prefecture,
    value.municipalityId,
    value.municipalityNameJa,
  ])
    if (field !== null && typeof field !== 'string')
      invalid('Invalid source text')
  for (const amount of [value.salePriceJpy, value.rentMonthlyJpy])
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))
      invalid('Invalid source money')
  for (const area of [value.floorAreaM2, value.landAreaM2])
    if (area !== null && (!Number.isFinite(area) || area < 0))
      invalid('Invalid source floor or land area')
  return {
    id: value.id,
    titleJa: value.titleJa,
    sourceRefs: value.sourceRefs.map((source) => ({
      sourceId: source.sourceId,
      externalId: source.externalId,
      name: source.name,
      url: source.url,
    })),
    primarySourceUrl: value.primarySourceUrl,
    transactionType: value.transactionType,
    salePriceJpy: value.salePriceJpy,
    rentMonthlyJpy: value.rentMonthlyJpy,
    priceNoteJa: value.priceNoteJa,
    propertyType: value.propertyType,
    floorAreaM2: value.floorAreaM2,
    landAreaM2: value.landAreaM2,
    prefecture: value.prefecture,
    municipalityId: value.municipalityId,
    municipalityNameJa: value.municipalityNameJa,
    availability: value.availability,
    location: location(value.location),
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    sourceCheckedAt: value.sourceCheckedAt,
  }
}
