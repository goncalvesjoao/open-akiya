import { useRef, useState } from 'react'
import type {
  LocationSearchResults,
  LocationMatch,
} from '../../shared/location-search'
import { isLocationMatch } from '../../shared/location-search'

export default function LocationSearch({
  onSelect,
}: {
  onSelect: (match: LocationMatch) => void
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<LocationSearchResults | null>(null)
  const [status, setStatus] = useState('')
  const version = useRef(0)
  function clear() {
    version.current++
    setResult(null)
    setStatus('')
  }
  return (
    <section aria-label="Find an area center" className="location-search">
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          clear()
          const text = query.trim()
          if (!text) {
            setStatus(
              'Enter an address or place name. Last valid selection retained.',
            )
            return
          }
          const request = version.current
          setStatus('Searching places…')
          try {
            const response = await window.openAkiya.searchLocations(text)
            if (version.current !== request) return
            if (response.matches.some((match) => !isLocationMatch(match)))
              throw new Error('Invalid location')
            setResult(response)
            setStatus(
              response.matches.length
                ? 'Choose a location to move the selected area.'
                : 'No matching places. Try another address or name. Last valid selection retained.',
            )
          } catch (error) {
            if (version.current !== request) return
            setStatus(
              error instanceof Error &&
                'code' in error &&
                error.code === 'LOCATION_RATE_LIMIT'
                ? 'Location provider rate limit reached. Wait and retry. Last valid selection retained.'
                : 'Location search unavailable or invalid response. Retry or use map and coordinate controls. See location search setup. Last valid selection retained.',
            )
          }
        }}
      >
        <label>
          Japanese address or place
          <input
            type="search"
            maxLength={300}
            value={query}
            onChange={(event) => {
              clear()
              setQuery(event.target.value)
            }}
          />
        </label>
        <button type="submit">Search places</button>
        <button
          type="button"
          onClick={() => {
            clear()
            setQuery('')
          }}
        >
          Clear place search
        </button>
      </form>
      <p>
        Search text is sent to your configured Nominatim provider. Japanese and
        supported Latin-script names in Japan are accepted. Coverage varies; a
        match is only an area center, not listing availability or an exact house
        location.
      </p>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <p>
        © OpenStreetMap contributors · ODbL ·{' '}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
        >
          OpenStreetMap attribution and license
        </a>
      </p>
      {result && (
        <>
          <ul aria-label="Place matches">
            {result.matches.map((match, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => {
                    clear()
                    onSelect(match)
                  }}
                >
                  {match.label}
                </button>
              </li>
            ))}
          </ul>
          <p>{result.attribution}</p>
        </>
      )}
    </section>
  )
}
