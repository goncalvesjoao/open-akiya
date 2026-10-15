import { distanceMetres } from '../shared/geography'
import type { MunicipalityGroup, SelectedArea } from '../shared/listings'

// Authored reference geometry only: these circles are not real municipal boundaries.
const references = [
  {
    municipalityId: 'fixture:municipality-1',
    center: { latitude: 35.06, longitude: 135 },
    radiusKm: 5,
    representativePoint: { latitude: 35.1, longitude: 135 },
    representativePointProvenance:
      'Synthetic municipal office; fictional reference circle centered at 35.06, 135 with radius 5 km',
  },
  {
    municipalityId: 'fixture:municipality-2',
    center: { latitude: 35.02, longitude: 135 },
    radiusKm: 1,
    representativePoint: null,
    representativePointProvenance: null,
  },
]

export function municipalityReference(
  municipalityId: string,
  area: SelectedArea,
):
  | Pick<
      MunicipalityGroup,
      'representativePoint' | 'representativePointProvenance'
    >
  | undefined {
  return references.find(
    (reference) =>
      reference.municipalityId === municipalityId &&
      distanceMetres(area.center, reference.center) <=
        (area.radiusKm + reference.radiusKm) * 1000 + 1e-8,
  )
}
