import type { AreaQuery, AreaResults } from '../../../shared/listings'
export {
  initialArea,
  isSelectedArea,
  distanceMetres,
  safeSourceUrl,
} from '../../../shared/geography'

export async function queryListings(query: AreaQuery): Promise<AreaResults> {
  return window.openAkiya.areaResults(query)
}
