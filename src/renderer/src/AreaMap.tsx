import { readRecovery, saveRecovery } from './recovery-storage'
import LocationSearch from './LocationSearch'
import ImportControls from './ImportControls'
import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { listingTitle, municipalityTitle } from './listings/presentation'
import 'leaflet/dist/leaflet.css'
import type {
  AreaResults,
  ListingProjection,
  MunicipalityGroup,
  SelectedArea,
} from '../../shared/listings'
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

function LocationUncertainty({ listing }: { listing: ListingProjection }) {
  if (listing.location.kind === 'municipality')
    return (
      <span className="location-uncertainty">
        Exact listing location and distance are unknown. Municipality only.
      </span>
    )
  if (listing.location.kind === 'unknown')
    return (
      <span className="location-uncertainty">
        Exact location and distance unknown. Shown because saved discovery
        evidence associates this offer with an intersecting source query.
      </span>
    )
  if (listing.location.kind !== 'unverified') return null
  return (
    <span className="location-uncertainty">
      Location unverified ·{' '}
      {listing.location.precision === 'approximate'
        ? 'Approximate source position'
        : 'Source position; accuracy unknown'}
      . True distance and radius membership are uncertain. Shown because the
      source point is inside the selected circle.
    </span>
  )
}

function ListingRow({
  listing,
  area,
  selected,
  onSelect,
}: {
  listing: ListingProjection
  area: SelectedArea
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button aria-pressed={selected} onClick={() => onSelect(listing.id)}>
        {listingTitle(listing)}
      </button>
      <span>
        {' '}
        · Last successful check:{' '}
        <time>{listing.sourceCheckedAt ?? 'Unknown'}</time>
      </span>
      <LocationUncertainty listing={listing} />
      {listing.location.kind === 'verified' && (
        <span>
          {' '}
          ·{' '}
          {(distanceMetres(area.center, listing.location.point) / 1000).toFixed(
            2,
          )}{' '}
          km · Verified synthetic position
        </span>
      )}
    </li>
  )
}

function ListingDetails({ listing }: { listing: ListingProjection }) {
  return (
    <section aria-label="Listing details" className="listing-details">
      <h3>{listingTitle(listing)}</h3>
      <LocationUncertainty listing={listing} />
      <p>
        Offer: {listing.id} · {listing.transactionType} · Availability:{' '}
        {listing.availability.replaceAll('_', ' ')}
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
      <details>
        <summary>Original Japanese source text</summary>
        <p lang="ja">{listing.titleJa}</p>
        {listing.priceNoteJa && <p lang="ja">{listing.priceNoteJa}</p>}
      </details>
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
  groups,
  expandedGroup,
  onGroup,
  selectedId,
  onSelect,
  onArea,
}: {
  area: SelectedArea
  listings: ListingProjection[]
  groups: MunicipalityGroup[]
  expandedGroup: string | null
  onGroup: (id: string) => void
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
    map.current!.panTo([area.center.latitude, area.center.longitude])
  }, [area.center.latitude, area.center.longitude])
  useEffect(() => {
    const instance = map.current!
    const layers = L.layerGroup().addTo(instance)
    L.circle([area.center.latitude, area.center.longitude], {
      radius: area.radiusKm * 1000,
      color: '#294e41',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(layers)
    for (const listing of listings) {
      if (
        listing.location.kind !== 'verified' &&
        listing.location.kind !== 'unverified'
      )
        continue
      const uncertain = listing.location.kind === 'unverified'
      const { latitude, longitude } = listing.location.point
      const button = document.createElement('button')
      button.type = 'button'
      button.className = uncertain
        ? 'listing-pin listing-pin-unverified'
        : 'listing-pin'
      button.textContent = uncertain
        ? '?'
        : listing.transactionType === 'rent'
          ? 'R'
          : 'S'
      button.setAttribute(
        'aria-label',
        `Pin: ${listingTitle(listing)}${uncertain ? ' · Location unverified' : ''}`,
      )
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
    for (const group of groups) {
      if (!group.representativePoint || !group.representativePointProvenance)
        continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'listing-pin municipality-pin'
      button.textContent = `M ${group.count}`
      button.setAttribute(
        'aria-label',
        `Municipality summary: ${municipalityTitle(group.municipalityId)} · ${group.count} ${group.count === 1 ? 'listing' : 'listings'}`,
      )
      button.setAttribute(
        'aria-pressed',
        String(
          expandedGroup === group.municipalityId ||
            group.listingIds.includes(selectedId ?? ''),
        ),
      )
      L.DomEvent.disableClickPropagation(button)
      button.addEventListener('click', () => onGroup(group.municipalityId))
      const { latitude, longitude } = group.representativePoint
      const displayedLongitude =
        longitude + 360 * Math.round((area.center.longitude - longitude) / 360)
      L.marker([latitude, displayedLongitude], {
        icon: L.divIcon({ html: button, className: '', iconSize: [50, 34] }),
        keyboard: false,
      }).addTo(layers)
    }
    return () => {
      layers.remove()
    }
  }, [area, listings, groups, expandedGroup, onGroup, selectedId, onSelect])
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

export default function AreaMap() {
  const [area, setArea] = useState(() => {
    const saved = readRecovery('selected-area')
    return isSelectedArea(saved) ? saved : initialArea
  })
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [draft, setDraft] = useState(() => [
    String(area.center.latitude),
    String(area.center.longitude),
    String(area.radiusKm),
  ])
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [results, setResults] = useState<AreaResults | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [queryError, setQueryError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const queryStatus = useRef<HTMLParagraphElement>(null)
  function selectArea(next: SelectedArea) {
    setSelectionRevision((value) => value + 1)
    setLoading(true)
    setQueryError('')
    saveRecovery('selected-area', next)
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
  }, [area, showUnavailable, revision])
  const matchingResults =
    results &&
    results.area.center.latitude === area.center.latitude &&
    results.area.center.longitude === area.center.longitude &&
    results.area.radiusKm === area.radiusKm &&
    results.showUnavailable === showUnavailable
      ? results
      : null
  const listings = matchingResults?.listings ?? []
  const groups = matchingResults?.municipalityGroups ?? []
  const groupedIds = new Set(groups.flatMap((group) => group.listingIds))
  const selectGroup = useCallback((id: string) => {
    setExpandedGroup(id)
    document.getElementById(`municipality-${id}`)?.focus()
  }, [])
  const selected = listings.find((listing) => listing.id === selectedId)
  return (
    <section
      id="map"
      className="synthetic-map container"
      aria-labelledby="map-title"
    >
      <h2 id="map-title">Explore a selected area</h2>
      <p>
        <strong>Sample data only — these are fictional offers.</strong> Click
        the map to choose a center; drag to pan and use + / − to zoom. Imports
        only start when you choose Import sample listings.
      </p>
      <LocationSearch
        key={selectionRevision}
        onSelect={(match) => selectArea({ ...area, center: match.center })}
      />
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
      <ImportControls
        area={area}
        onSettled={() => {
          setLoading(true)
          setQueryError('')
          setRevision((value) => value + 1)
        }}
      />
      <div className="map-layout">
        <div>
          <MapCanvas
            area={area}
            listings={listings}
            groups={groups}
            expandedGroup={expandedGroup}
            onGroup={selectGroup}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onArea={selectArea}
          />
        </div>
        <div>
          <p role="status" ref={queryStatus} tabIndex={-1}>
            {loading
              ? 'Loading listings…'
              : queryError ||
                `${listings.length} synthetic listings. No real inventory.`}
          </p>
          {queryError && (
            <button
              onClick={() => {
                setLoading(true)
                setQueryError('')
                queryStatus.current?.focus()
                setRevision((value) => value + 1)
              }}
            >
              Retry listing query
            </button>
          )}
          {!matchingResults && results && (
            <p>
              Previous results belong to a different area or filter and are
              hidden. Last successful data is retained; a failed query does not
              establish withdrawal.
            </p>
          )}
          {!loading && !queryError && listings.length === 0 && (
            <p>
              No listings in this selected area. This does not prove withdrawal
              or complete coverage.
            </p>
          )}
          {matchingResults && (
            <div>
              <p>
                Coverage {matchingResults.coverage.status}; configured sources
                only, never complete inventory. Last successful covering check:{' '}
                {matchingResults.coverage.lastSuccessfulCheckAt ?? 'Unknown'}.{' '}
                Fresh until: {matchingResults.coverage.freshUntil ?? 'Unknown'}.
              </p>
              {matchingResults.coverage.caveats.map((caveat, index) => (
                <p key={index}>{caveat}</p>
              ))}
            </div>
          )}
          <ul className="listing-results" aria-label="Listing results">
            {listings
              .filter(
                (listing) =>
                  !groupedIds.has(listing.id) &&
                  listing.location.kind !== 'unknown',
              )
              .map((listing) => (
                <ListingRow
                  key={listing.id}
                  listing={listing}
                  area={area}
                  selected={selectedId === listing.id}
                  onSelect={setSelectedId}
                />
              ))}
            {groups.map((group) => (
              <li key={group.municipalityId}>
                <div
                  role="group"
                  aria-label={`Municipality summary: ${municipalityTitle(group.municipalityId)}`}
                >
                  <p>
                    Municipality summary · Exact listing locations and distances
                    are unknown. The point represents the municipality, not an
                    individual listing.
                  </p>
                  {!group.representativePoint && (
                    <p>
                      No documented representative point; listings remain
                      available here without a map marker.
                    </p>
                  )}
                  {group.representativePointProvenance && (
                    <p>
                      Representative point provenance:{' '}
                      {group.representativePointProvenance}
                    </p>
                  )}
                  <details open={expandedGroup === group.municipalityId}>
                    <summary
                      id={`municipality-${group.municipalityId}`}
                      onClick={(event) => {
                        event.preventDefault()
                        setExpandedGroup(
                          expandedGroup === group.municipalityId
                            ? null
                            : group.municipalityId,
                        )
                      }}
                    >
                      {municipalityTitle(group.municipalityId)} · {group.count}{' '}
                      {group.count === 1 ? 'listing' : 'listings'}
                    </summary>
                    <details>
                      <summary>Original Japanese municipality name</summary>
                      <p lang="ja">{group.nameJa}</p>
                    </details>
                    <ul
                      aria-label={`Offers in ${municipalityTitle(group.municipalityId)}`}
                    >
                      {group.listingIds
                        .map((id) =>
                          listings.find((listing) => listing.id === id),
                        )
                        .filter((listing): listing is ListingProjection =>
                          Boolean(listing),
                        )
                        .map((listing) => (
                          <ListingRow
                            key={listing.id}
                            listing={listing}
                            area={area}
                            selected={selectedId === listing.id}
                            onSelect={setSelectedId}
                          />
                        ))}
                    </ul>
                  </details>
                </div>
              </li>
            ))}
          </ul>
          <h3>Unknown location</h3>
          <ul className="listing-results" aria-label="Unknown location">
            {listings
              .filter((listing) => listing.location.kind === 'unknown')
              .map((listing) => (
                <ListingRow
                  key={listing.id}
                  listing={listing}
                  area={area}
                  selected={selectedId === listing.id}
                  onSelect={setSelectedId}
                />
              ))}
          </ul>
          {selected && <ListingDetails listing={selected} />}
        </div>
      </div>
    </section>
  )
}
