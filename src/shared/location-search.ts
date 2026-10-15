import type { Point } from './listings'

export type LocationMatch = { label: string; center: Point }
export type LocationSearchResults = {
  matches: LocationMatch[]
  attribution: string
}
export function isLocationMatch(value: LocationMatch): boolean {
  return (
    typeof value.label === 'string' &&
    value.label.trim().length > 0 &&
    Number.isFinite(value.center?.latitude) &&
    Math.abs(value.center.latitude) <= 90 &&
    Number.isFinite(value.center?.longitude) &&
    Math.abs(value.center.longitude) <= 180
  )
}
