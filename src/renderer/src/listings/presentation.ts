import type { ListingProjection } from '../../../shared/listings'

// Authored English labels for fictional fixtures, not source translations.
const sampleTitles: Record<string, string> = {
  'sample-sale-1': 'Sample sale listing',
  'sample-rent-1': 'Sample rental listing',
  'sample-unknown-1': 'Sample listing with unknown price',
  'sample-unavailable-1': 'Unavailable sample listing',
  'sample-outside-1': 'Sample listing outside the area',
  'sample-antimeridian-1': 'Antimeridian sample listing',
  'sample-boundary-1': 'Boundary sample listing',
}

export function listingTitle(listing: ListingProjection): string {
  return sampleTitles[listing.id] ?? 'Listing from original source'
}
