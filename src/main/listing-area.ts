import { distanceMetres } from '../shared/geography'
import type { Location, SelectedArea } from '../shared/listings'
import { municipalityReference } from './municipalities'

// Shared candidate membership for synthetic discovery and saved-results reads.
// Source-point inclusion does not certify an unverified offer's true location.
export function locationMatchesArea(
  location: Location,
  area: SelectedArea,
): boolean {
  return location.kind === 'municipality'
    ? Boolean(municipalityReference(location.municipalityId, area))
    : (location.kind === 'verified' || location.kind === 'unverified') &&
        distanceMetres(area.center, location.point) <=
          area.radiusKm * 1000 + 1e-8
}
