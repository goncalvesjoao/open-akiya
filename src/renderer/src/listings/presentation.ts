import type { ListingProjection } from '../../../shared/listings'

// Authored English labels for fictional fixtures, not source translations.
const sampleTitles: Record<string, string> = {
  'sample-municipality-1': 'Municipality sample listing',
  'sample-municipality-unavailable-1':
    'Unavailable municipality sample listing',
  'sample-municipality-no-point-1':
    'Municipality sample listing without a point',
  'sample-municipality-source-point-1':
    'Municipal office source-point sample listing',
  'sample-unverified-1': 'Unverified sample listing',
  'sample-approximate-1': 'Approximate sample listing',
  'sample-unverified-unavailable-1': 'Unavailable unverified sample listing',
  'sample-sale-1': 'Sample sale listing',
  'sample-rent-1': 'Sample rental listing',
  'sample-unknown-1': 'Sample listing with unknown price',
  'sample-unavailable-1': 'Unavailable sample listing',
  'sample-outside-1': 'Sample listing outside the area',
  'sample-antimeridian-1': 'Antimeridian sample listing',
  'sample-boundary-1': 'Boundary sample listing',
}

export function listingTitle(listing: ListingProjection): string {
  const source = listing.sourceRefs.find(
    (source) => source.sourceId === 'fixture',
  )
  return (
    sampleTitles[source ? `sample-${source.externalId}` : listing.id] ??
    'Listing from original source'
  )
}

export function municipalityTitle(id: string): string {
  return id === 'fixture:municipality-1'
    ? 'Sample municipality'
    : id === 'fixture:municipality-2'
      ? 'Sample municipality without a point'
      : 'Municipality'
}
