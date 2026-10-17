import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { Point, SelectedArea } from '../shared/listings'
import { distanceMetres } from '../shared/geography'
import { LocalApiError } from './errors'
import type { municipalityReference } from './municipalities'

// Reference bytes remain private. No boundary is bundled and this loader does
// not activate a source. The explicit caller must supply its locally held file.
export const tsubataReferenceEdition = {
  edition: 'MLIT N03 2026-01-01 Ishikawa, N03_007=17361 / 津幡町',
  sha256: '348149cca7c04b9ac6d942229e894cc9922a74734e0ac6f06d994f1bca9376bc',
}
const algorithm = 'tsubata-spherical-edges-scanline-v1'
type Coordinate = [number, number]
type Polygon = Coordinate[][]
const invalid = (message: string): never => {
  throw new LocalApiError(409, 'CONFIGURATION_ERROR', message)
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
function polygons(value: unknown): Polygon[] {
  if (!Array.isArray(value) || !value.length)
    return invalid('Missing municipal polygons')
  for (const polygon of value) {
    if (!Array.isArray(polygon) || !polygon.length)
      return invalid('Missing municipal rings')
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4)
        return invalid('Invalid municipal ring')
      for (const coordinate of ring)
        if (
          !Array.isArray(coordinate) ||
          coordinate.length !== 2 ||
          !coordinate.every(
            (n) => typeof n === 'number' && Number.isFinite(n),
          ) ||
          Math.abs(coordinate[0]) > 180 ||
          Math.abs(coordinate[1]) >= 89
        )
          return invalid('Invalid municipal coordinate')
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
        return invalid('Unclosed municipal ring')
    }
  }
  // This source-specific algorithm uses longitude ray crossings. Its reviewed
  // Japanese reference must not cross the antimeridian or approach a pole.
  const coordinates: Coordinate[] = value.flat(2)
  if (
    Math.max(...coordinates.map((c) => c[0])) -
      Math.min(...coordinates.map((c) => c[0])) >=
    180
  )
    return invalid('Unsupported municipal longitude span')
  return value as Polygon[]
}
function ringContains(ring: Coordinate[], point: Point): boolean {
  let inside = false
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1]
    const [x2, y2] = ring[i]
    if (
      y1 > point.latitude !== y2 > point.latitude &&
      point.longitude < ((x2 - x1) * (point.latitude - y1)) / (y2 - y1) + x1
    )
      inside = !inside
  }
  return inside
}
function contains(polygon: Polygon, point: Point) {
  return (
    ringContains(polygon[0], point) &&
    !polygon.slice(1).some((ring) => ringContains(ring, point))
  )
}
const radians = Math.PI / 180
const point = ([longitude, latitude]: Coordinate): Point => ({
  longitude,
  latitude,
})
const bearing = (a: Point, b: Point) => {
  const delta = (b.longitude - a.longitude) * radians
  return Math.atan2(
    Math.sin(delta) * Math.cos(b.latitude * radians),
    Math.cos(a.latitude * radians) * Math.sin(b.latitude * radians) -
      Math.sin(a.latitude * radians) *
        Math.cos(b.latitude * radians) *
        Math.cos(delta),
  )
}
function edgeDistance(
  center: Point,
  start: Coordinate,
  end: Coordinate,
): number {
  const a = point(start)
  const b = point(end)
  const length = distanceMetres(a, b)
  const distance = distanceMetres(a, center)
  if (length === 0) return distance
  const angle = bearing(a, center) - bearing(a, b)
  const along =
    Math.atan2(
      Math.sin(distance / 6371000) * Math.cos(angle),
      Math.cos(distance / 6371000),
    ) * 6371000
  return along >= 0 && along <= length
    ? Math.abs(
        Math.asin(
          Math.max(
            -1,
            Math.min(1, Math.sin(distance / 6371000) * Math.sin(angle)),
          ),
        ),
      ) * 6371000
    : Math.min(distance, distanceMetres(b, center))
}
function representative(polygons: Polygon[]): Point {
  let widest = 0
  let result: Point | undefined
  for (const polygon of polygons) {
    const latitudes = [...new Set(polygon.flat().map((c) => c[1]))].sort(
      (a, b) => a - b,
    )
    for (let i = 1; i < latitudes.length; i++) {
      const latitude = (latitudes[i - 1] + latitudes[i]) / 2
      const crossings: number[] = []
      for (const ring of polygon)
        for (let j = 1; j < ring.length; j++) {
          const [x1, y1] = ring[j - 1]
          const [x2, y2] = ring[j]
          if (y1 > latitude !== y2 > latitude)
            crossings.push(x1 + ((x2 - x1) * (latitude - y1)) / (y2 - y1))
        }
      crossings.sort((a, b) => a - b)
      for (let j = 1; j < crossings.length; j++) {
        const candidate = {
          latitude,
          longitude: (crossings[j - 1] + crossings[j]) / 2,
        }
        const width = crossings[j] - crossings[j - 1]
        if (width > widest && contains(polygon, candidate)) {
          widest = width
          result = candidate
        }
      }
    }
  }
  return result ?? invalid('Municipality has no usable point on surface')
}
export function loadTsubataGeography(
  path: string,
  reference = tsubataReferenceEdition,
): {
  adapterOptions: {
    geographyVersion: string
    intersectsMunicipality(area: SelectedArea): boolean
  }
  runtimeOptions: {
    referenceVersion: string
    municipalityReference: typeof municipalityReference
  }
} {
  let bytes: Buffer
  try {
    if (statSync(path).size > 32 * 1024 * 1024)
      return invalid('Municipal reference exceeds byte limit')
    bytes = readFileSync(path)
  } catch {
    return invalid('Private municipal reference file unavailable')
  }
  const checksum = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength > 32 * 1024 * 1024)
    return invalid('Municipal reference exceeds byte limit')
  if (checksum !== reference.sha256)
    return invalid('Private municipal reference checksum mismatch')
  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch {
    return invalid('Invalid municipal reference JSON')
  }
  if (
    !record(document) ||
    document.type !== 'FeatureCollection' ||
    !Array.isArray(document.features)
  )
    return invalid('Invalid municipal feature collection')
  const matches = document.features.filter(
    (f: unknown) =>
      record(f) && record(f.properties) && f.properties.N03_007 === '17361',
  )
  if (matches.length !== 1)
    return invalid('Municipal reference identity ambiguous or missing')
  const feature = matches[0]
  if (
    !record(feature.properties) ||
    feature.properties.N03_004 !== '津幡町' ||
    !record(feature.geometry) ||
    feature.geometry.type !== 'MultiPolygon'
  )
    return invalid('Municipal reference name or geometry mismatch')
  const boundary = polygons(feature.geometry.coordinates)
  const representativePoint = representative(boundary)
  const version = `${algorithm}:${checksum}`
  // Mean-earth spherical edge distance, inclusive touch plus 1 m numerical/CRS
  // tolerance. JGD2011 longitude/latitude values are used numerically in the
  // map's geographic convention; no claim of cadastral/survey precision.
  const intersectsMunicipality = (area: SelectedArea) =>
    boundary.some(
      (polygon) =>
        contains(polygon, area.center) ||
        polygon.some((ring) =>
          ring
            .slice(1)
            .some(
              (end, i) =>
                edgeDistance(area.center, ring[i], end) <=
                area.radiusKm * 1000 + 1,
            ),
        ),
    )
  const representativePointProvenance = `${reference.edition}; SHA-256 ${checksum}; ${algorithm}; widest interior scanline interval midpoint (ring latitude bands, holes excluded); JGD2011 longitude/latitude used numerically without datum transformation; municipality representative, never a home; source: https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html; CC BY 4.0 https://creativecommons.org/licenses/by/4.0/; private local reference, not bundled for redistribution; processed by Open Akiya`
  return {
    adapterOptions: { geographyVersion: version, intersectsMunicipality },
    runtimeOptions: {
      referenceVersion: version,
      municipalityReference: (id, area) =>
        id === '173614' && intersectsMunicipality(area)
          ? { representativePoint, representativePointProvenance }
          : undefined,
    },
  }
}
