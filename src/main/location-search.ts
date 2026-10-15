import type {
  LocationMatch,
  LocationSearchResults,
} from '../shared/location-search'
import { isLocationMatch } from '../shared/location-search'
import { LocalApiError, invalid } from './errors'

// Only operator-configured self-hosted Nominatim is supported. The public OSMF
// endpoint has aggregate application limits that independent installs cannot enforce.
export function createLocationSearch(
  endpoint?: string,
  fetcher: typeof fetch = fetch,
) {
  const cache = new Map<string, LocationSearchResults>()
  let availableAt = 0
  let busy = false
  return async (input: unknown): Promise<LocationSearchResults> => {
    if (typeof input !== 'string' || !input.trim() || input.trim().length > 300)
      invalid('Enter an address or place name of at most 300 characters.')
    const query = input.trim()
    if (!endpoint)
      throw new LocalApiError(
        503,
        'LOCATION_UNAVAILABLE',
        'Location search is not configured. See location search setup; map and coordinate controls remain available.',
      )
    let url: URL
    try {
      url = new URL(endpoint)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        url.hostname.replace(/\.$/, '') === 'nominatim.openstreetmap.org'
      )
        throw new Error()
    } catch {
      throw new LocalApiError(
        503,
        'LOCATION_UNAVAILABLE',
        'Location search configuration is invalid. Use a self-hosted Nominatim search endpoint.',
      )
    }
    const cached = cache.get(query)
    if (cached) return cached
    if (busy || Date.now() < availableAt)
      throw new LocalApiError(
        429,
        'LOCATION_RATE_LIMIT',
        'Location search rate limit reached. Wait before retrying.',
      )
    busy = true
    availableAt = Date.now() + 1000
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('countrycodes', 'jp')
    url.searchParams.set('addressdetails', '1')
    url.searchParams.set('limit', '5')
    url.searchParams.set('accept-language', 'ja,en')
    try {
      const response = await fetcher(url.href, {
        headers: {
          'User-Agent':
            'OpenAkiya/0.1 (+https://github.com/goncalvesjoao/open-akiya)',
        },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      })
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after') ?? ''
        const seconds = Number(retryAfter)
        const delay = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now()
        availableAt =
          Date.now() + Math.max(1000, Number.isFinite(delay) ? delay : 1000)
        throw new LocalApiError(
          429,
          'LOCATION_RATE_LIMIT',
          'Location provider rate limit reached. Wait before retrying.',
        )
      }
      if (!response.ok) throw new Error()
      const data: unknown = await response.json()
      if (!Array.isArray(data)) throw new Error()
      const matches: LocationMatch[] = []
      for (const row of data.slice(0, 5)) {
        if (
          !row ||
          typeof row !== 'object' ||
          row.address?.country_code !== 'jp' ||
          typeof row.display_name !== 'string' ||
          typeof row.lat !== 'string' ||
          !row.lat.trim() ||
          typeof row.lon !== 'string' ||
          !row.lon.trim()
        )
          continue
        const match = {
          label: row.display_name,
          center: { latitude: Number(row.lat), longitude: Number(row.lon) },
        }
        if (isLocationMatch(match)) matches.push(match)
      }
      const result = {
        matches,
        attribution: '© OpenStreetMap contributors · ODbL',
      }
      if (cache.size >= 100) cache.delete(cache.keys().next().value!)
      cache.set(query, result)
      return result
    } catch (error) {
      if (error instanceof LocalApiError) throw error
      throw new LocalApiError(
        503,
        'LOCATION_UNAVAILABLE',
        'Location provider unavailable. Retry or use the map and coordinate controls.',
      )
    } finally {
      busy = false
    }
  }
}
