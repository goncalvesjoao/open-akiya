import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type {
  AreaResults,
  ListingProjection,
  SelectedArea,
} from './listings/contracts'
import {
  distanceMetres,
  initialArea,
  isSelectedArea,
  queryListings,
  safeSourceUrl,
} from './listings/query'

function money(value: number | null) {
  return value === null
    ? 'Unknown'
    : value === 0
      ? 'Free (¥0)'
      : `¥${value.toLocaleString('en-US')}`
}

function ListingDetails({ listing }: { listing: ListingProjection }) {
  return (
    <section aria-label="Listing details" className="listing-details">
      <h3 lang="ja">{listing.titleJa}</h3>
      <p>
        Offer: {listing.id} · {listing.transactionType} · Availability:{' '}
        {listing.availability}
      </p>
      {(listing.transactionType === 'sale' ||
        listing.transactionType === 'both') && (
        <p>Sale: {money(listing.salePriceJpy)}</p>
      )}
      {(listing.transactionType === 'rent' ||
        listing.transactionType === 'both') && (
        <p>Rent: {money(listing.rentMonthlyJpy)} / month</p>
      )}
      <p>
        Last successful check:{' '}
        <time>{listing.sourceCheckedAt ?? 'Unknown'}</time>
      </p>
      {listing.priceNoteJa && <p lang="ja">{listing.priceNoteJa}</p>}
      {listing.sourceRefs.map((source) => {
        const url = safeSourceUrl(source.sourceId, source.url)
        return (
          <p key={`${source.sourceId}:${source.externalId}`}>
            {source.name}:{' '}
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                Original source ↗
              </a>
            ) : (
              'Source URL unavailable'
            )}
          </p>
        )
      })}
    </section>
  )
}

function MapCanvas({
  area,
  listings,
  selectedId,
  onSelect,
  onArea,
}: {
  area: SelectedArea
  listings: ListingProjection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onArea: (area: SelectedArea) => void
}) {
  const element = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const [tileError, setTileError] = useState(false)
  const callbacks = useRef({ area, onArea })
  useEffect(() => {
    callbacks.current = { area, onArea }
  }, [area, onArea])
  useEffect(() => {
    const instance = L.map(element.current!, {
      center: [35, 135],
      zoom: 12,
      worldCopyJump: true,
      zoomAnimation: false,
      fadeAnimation: false,
      inertia: false,
    })
    map.current = instance
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    })
      .on('tileerror', () => setTileError(true))
      .addTo(instance)
    instance.on('click', (event: L.LeafletMouseEvent) => {
      const point = event.latlng.wrap()
      const next = {
        ...callbacks.current.area,
        center: { latitude: point.lat, longitude: point.lng },
      }
      if (isSelectedArea(next)) callbacks.current.onArea(next)
    })
    return () => {
      instance.remove()
      map.current = null
    }
  }, [])
  useEffect(() => {
    const instance = map.current!
    instance.panTo([area.center.latitude, area.center.longitude])
    const layers = L.layerGroup().addTo(instance)
    L.circle([area.center.latitude, area.center.longitude], {
      radius: area.radiusKm * 1000,
      color: '#294e41',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(layers)
    for (const listing of listings) {
      if (listing.location.kind !== 'verified') continue
      const { latitude, longitude } = listing.location.point
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'listing-pin'
      button.textContent = listing.transactionType === 'rent' ? 'R' : 'S'
      button.setAttribute('aria-label', `Pin: ${listing.titleJa}`)
      button.setAttribute('aria-pressed', String(listing.id === selectedId))
      L.DomEvent.disableClickPropagation(button)
      button.addEventListener('click', () => onSelect(listing.id))
      // Place wrapped offers in the same world copy as the selected center.
      const displayedLongitude =
        longitude + 360 * Math.round((area.center.longitude - longitude) / 360)
      L.marker([latitude, displayedLongitude], {
        icon: L.divIcon({ html: button, className: '', iconSize: [34, 34] }),
        keyboard: false,
      }).addTo(layers)
    }
    return () => {
      layers.remove()
    }
  }, [area, listings, selectedId, onSelect])
  return (
    <>
      <div
        ref={element}
        className="map-canvas"
        role="region"
        aria-label="Interactive synthetic map"
      />
      {tileError && (
        <p role="status">
          Map tiles unavailable. Area controls and listing results remain
          usable.
        </p>
      )}
    </>
  )
}

export default function SyntheticMap() {
  const [area, setArea] = useState(initialArea)
  const [draft, setDraft] = useState(['35', '135', '5'])
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [results, setResults] = useState<AreaResults | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [queryError, setQueryError] = useState('')
  const [loading, setLoading] = useState(true)
  function selectArea(next: SelectedArea) {
    setLoading(true)
    setQueryError('')
    setArea(next)
    setDraft([
      String(next.center.latitude),
      String(next.center.longitude),
      String(next.radiusKm),
    ])
    setError('')
  }
  useEffect(() => {
    let active = true
    queryListings({ area, showUnavailable }).then(
      (result) => {
        if (active) {
          setResults(result)
          setSelectedId((id) =>
            result.listings.some((listing) => listing.id === id) ? id : null,
          )
          setLoading(false)
        }
      },
      () => {
        if (active) {
          setQueryError(
            'Listing query failed. This does not establish withdrawal.',
          )
          setLoading(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [area, showUnavailable])
  const listings = results?.listings ?? []
  const selected = listings.find((listing) => listing.id === selectedId)
  return (
    <section
      id="map"
      className="synthetic-map container"
      aria-labelledby="map-title"
    >
      <h2 id="map-title">Synthetic map</h2>
      <p>
        <strong>Sample data only — these are fictional offers.</strong> Click
        the map to choose a center; drag to pan and use + / − to zoom. No
        geolocation or collection requests.
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          const next = {
            center: {
              latitude: draft[0].trim() === '' ? NaN : Number(draft[0]),
              longitude: draft[1].trim() === '' ? NaN : Number(draft[1]),
            },
            radiusKm: draft[2].trim() === '' ? NaN : Number(draft[2]),
          }
          if (isSelectedArea(next)) selectArea(next)
          else
            setError(
              'Choose finite latitude [-90, 90], longitude [-180, 180], and radius greater than 0 and at most 10 km. Last valid selection retained.',
            )
        }}
      >
        {['Latitude', 'Longitude', 'Radius (km)'].map((label, index) => (
          <label key={label}>
            {label}
            <input
              type="text"
              inputMode="decimal"
              value={draft[index]}
              onChange={(event) =>
                setDraft((values) =>
                  values.map((value, i) =>
                    i === index ? event.target.value : value,
                  ),
                )
              }
            />
          </label>
        ))}
        <button type="submit">Apply area</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p>
        Selected: {area.center.latitude}, {area.center.longitude} ·{' '}
        {area.radiusKm} km
      </p>
      <label>
        <input
          type="checkbox"
          checked={showUnavailable}
          onChange={(event) => {
            setLoading(true)
            setQueryError('')
            setShowUnavailable(event.target.checked)
          }}
        />{' '}
        Show unavailable
      </label>
      <div className="map-layout">
        <div>
          <MapCanvas
            area={area}
            listings={listings}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onArea={selectArea}
          />
        </div>
        <div>
          <p role="status">
            {loading
              ? 'Loading listings…'
              : queryError ||
                `${listings.length} synthetic listings. Coverage unknown; no real inventory.`}
          </p>
          {!loading && !queryError && listings.length === 0 && (
            <p>
              No listings in this selected area. This does not prove withdrawal
              or complete coverage.
            </p>
          )}
          <ul className="listing-results" aria-label="Listing results">
            {listings.map((listing) => (
              <li key={listing.id}>
                <button
                  aria-pressed={selectedId === listing.id}
                  onClick={() => setSelectedId(listing.id)}
                  lang="ja"
                >
                  {listing.titleJa}
                </button>
                {listing.location.kind === 'verified' && (
                  <span>
                    {' '}
                    ·{' '}
                    {(
                      distanceMetres(area.center, listing.location.point) / 1000
                    ).toFixed(2)}{' '}
                    km · Verified synthetic position
                  </span>
                )}
              </li>
            ))}
          </ul>
          {selected && <ListingDetails listing={selected} />}
        </div>
      </div>
    </section>
  )
}
