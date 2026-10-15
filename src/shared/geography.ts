import type { Point, SelectedArea } from './listings'

export const initialArea: SelectedArea = {
  center: { latitude: 35, longitude: 135 },
  radiusKm: 5,
}
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
