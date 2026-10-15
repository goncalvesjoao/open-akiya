# Map, listing pins, and bounded area selection

## Desktop runtime

Use Electron, React/TypeScript, a utility-process worker and worker-owned SQLite. Job operations cross a validated, context-isolated preload bridge; there is no local HTTP server. The renderer cannot access Node.js, SQL, source observations or arbitrary IPC. Closing the window keeps the application and imports running; reopening from the launcher restores the window. Explicit Quit stops scheduling and preserves committed work for recovery on restart. Cancelled work never resumes automatically. Sleep, shutdown and process crashes interrupt execution; no operating-system service or scheduling while fully exited is promised.

The full acceptance requirements below remain targets. The desktop foundation implements basic synthetic create/list/inspect/cancel/results operations, exact-area active-job reuse and restart recovery. It does **not** complete freshness/containment policies, request-intent ownership, manual-refresh follow-ups, bounded continuation, rich job counters, all location variants, address lookup or live-source activation. See [desktop runtime](../desktop-runtime.md) for the implementation boundary. Keep these gaps explicit rather than weakening acceptance.

Part of #1. Can start immediately and run alongside #5 after shared contract alignment; no live source dependency; the desktop foundation supplies the saved-result query worker. See the [implementation plan](../implementation-plan.md).

## Problem Statement

The Electron app provides a basic synthetic map and reads saved sample imports. Users need a map and a clear area selection before they can request an area import.

## Solution

Provide a responsive map and companion results list using clearly labeled synthetic listings. Users select a center and a positive radius up to 10 km, inspect listing details and source links, and understand location uncertainty. This creates the interaction and presentation foundation for later import jobs.

## User Stories

1. As a user, I want to open an interactive map, so that I can explore Japan geographically.
2. As a user, I want to pan and zoom, so that I can reach an area of interest.
3. As a user, I want to select an area center, so that I can define where to search.
4. As a keyboard user, I want labeled center-coordinate controls, so that selection does not require pointer gestures.
5. As a user, I want to set a positive radius up to 10 km, so that the scope stays bounded.
6. As a user, I want a visible search circle and radius value, so that I understand the selected area.
7. As a user, I want invalid values explained without changing the valid selection, so that errors are recoverable.
8. As a user, I want listing pins and a matching results list, so that I can explore spatially or textually.
9. As a user, I want to select a pin or list entry, so that I can inspect the same property's details.
10. As a user, I want Japanese titles and source links, so that I can verify information.
11. As a user, I want sale, rent, unknown price, and free distinguished, so that amounts are understandable.
12. As a user, I want source-provided positions shown as individual pins with unverified or approximate labels where appropriate, so that I can explore them without mistaking them for verified house locations.
13. As a user, I want loading, empty, and error states, so that I understand missing results.
14. As a mobile user, I want usable map controls and readable details, so that I can explore on a small screen.
15. As a user, I want sample data clearly labeled, so that I do not mistake demonstrations for real offers.
16. As a user, I want selection and navigation to make no collection requests, so that exploration does not trigger scraping.
17. As a user, I want a distinct municipality summary pin with a count and expandable listing list, so that I can explore offers known only to municipality level.
18. As a user, I want unknown-location offers accessible without a fabricated pin, so that I can still inspect their source information.
19. As a user, I want unavailable offers hidden by default but accessible through Show unavailable, so that I can explore current offers without losing history.

20. As a user, I want to search for an address or place name and explicitly choose a matching location, so that I can select an area without knowing coordinates.

## Implementation Decisions

- Use English for the current interface, including navigation, controls, statuses, accessible names and synthetic listing display titles. English and Japanese may become interface locales later; no locale selector or Japanese interface is required now. Keep original Japanese source fields unchanged and available in a separately labeled, initially collapsed original-source section. Authored English synthetic fixture labels are presentation text, not translations of real source content. Do not change the shared listing DTO or introduce automatic translation.

- Build on the React/TypeScript renderer and keep the project purpose visible. Use the bundled utility-process worker for saved results; no separately provisioned backend is required.
- Choose a map library and tile provider during implementation; document attribution, configuration, network requirements, and any required user key. Locally running does not mean offline tiles. Do not require browser geolocation.
- Represent the selected area with center latitude/longitude and radius in kilometres; validate finite coordinates and a radius greater than zero and at most 10. Provide pointer selection and labeled keyboard-operable coordinate/radius controls.
- The circle represents geographic distance, not a screen-space approximation. Include the boundary in the precise-location result filter. Selection changes update displayed sample results but never create import jobs.
- Define a replaceable listing-query boundary whose desktop implementation reads imported synthetic fixtures from SQLite. Its input is the area; its output distinguishes verified in-area positions, source-provided unverified/approximate positions, municipality-only groups, and unknown-location candidates, with freshness and coverage metadata reserved for later integration. An empty collection is different from a failed query.
- Use stable listing identifiers, Japanese title, original source reference, sale/rent amounts, availability, and location precision. Missing money is unknown; zero is explicitly free. Avoid inventing coordinates, translations, or source data. Use synthetic identifiers and clearly non-real fixture content.
- Keep pin selection and list selection synchronized. Show the same details and original-source action from either. Show individual pins at source-provided coordinates even if unverified, using distinct styling and a Location unverified label. Approximate positions also explain that distance from the selected center is uncertain; coordinate-based candidate inclusion is not verified radius membership.
- Group offers with only municipality-level locations by municipality intersecting the selected circle. Use a distinct municipality summary pin at a documented representative point, such as the municipal office, with a count and selectable list. Its label explains that exact locations and distance from the selected center are unknown. The representative point may lie outside the circle; do not exclude a group solely for that reason. Keep provenance for the representative point and do not display it as a house location.
- Offers without source-provided coordinates or a known municipality remain in an Unknown location list without a pin. Do not geocode or invent a house position. A source-provided point known to represent only the municipality belongs in the municipality group rather than an individual house pin.
- Hide explicitly unavailable offers by default and provide Show unavailable in the map and list, including municipality counts. Preserve Japanese source text and successful-check timestamps; a missing result or failed request does not prove withdrawal.
- Handle coincident pins so every listing remains reachable through the list. Clustering is optional, not a prerequisite.
- Render source text as text and validate navigable source URLs. Show accessible status messages, meaningful focus behavior, and a usable list even if tiles fail.
- Provide loading, no results, provider failure, and partial-location states. Keep sample mode prominently labeled. Later jobs plug into the query boundary without replacing the map's selection contract.

## Testing Decisions

- Use the previously confirmed Electron end-to-end seam with deterministic synthetic listings; test user-visible selection, radius validation, marker/list correspondence, details, and source navigation. The full import journey is extended in the next spec.
- Assert geographic filtering at the listing-query boundary using known inside, outside, boundary, unverified, approximate, municipality-only, unknown-location, and coincident-location examples. Include an intersecting municipality whose summary point is outside the circle. Verify summary counts/list navigation, unverified labels, distance uncertainty, and Show unavailable behavior. Prefer observable result membership over map-library internals.
- Verify keyboard area selection, invalid numeric input, empty/error states, and a mobile viewport. Test tiles with controlled network responses so checks do not depend on a live provider.
- Extend the existing map, SQLite and Electron checks for these behaviors; automated tests make no live bank requests.

## Out of Scope

- Import workers, job persistence, live bank adapters and collection scheduling.
- Geocoding listing positions, automatic user location, route planning, translation, photo copying, and advanced filters beyond Show unavailable. User-entered address/place lookup for selecting the area center is included through #38.
- Public deployment and a distributed real listing dataset.

## Further Notes

- This is the first deliverable under the confirmed parent spec. It is complete when the fixture-backed exploration flow works without live-source permissions or external backend setup.

## Shared selected-area and query contract

Contract alignment, 2026-10-15. This section owns `SelectedArea`; #5 owns the listing projection and results envelope, and #6 owns coverage/freshness semantics. These are documentation contracts for implementation, not claims of implemented endpoints. Consumers reuse these definitions rather than introducing map-specific listing DTOs.

```ts
type Point = { latitude: number; longitude: number }
type SelectedArea = { center: Point; radiusKm: number }
type AreaQuery = { area: SelectedArea; showUnavailable: boolean }
```

Coordinates are WGS84 decimal degrees, latitude in [-90, 90], longitude in [-180, 180]; all numbers must be finite. Radius is kilometres, strictly positive and at most 10; no silent clamping. Reject numeric strings, nulls and missing members at the API. Invalid control drafts retain the last valid area. Worker and renderer apply the same validation. Preserve the accepted coordinates/radius in job input; map movement cannot mutate it. Distances and circle containment use geodesic distance in metres internally, with boundary included; longitude wrapping must work across the antimeridian. No Japan-only coordinate restriction is implied by source support.

Example query-boundary input (also the `areaResults(query)` input):

```json
{
  "area": { "center": { "latitude": 35.0, "longitude": 135.0 }, "radiusKm": 5 },
  "showUnavailable": false
}
```

The replaceable boundary is `queryListings(query: AreaQuery): Promise<AreaResults>` using #5's response. Synthetic mode implements this boundary through the bundled worker without requiring an external backend. Querying results reads saved data and never starts collection. Query errors reject distinctly from a successful empty response.

Verified coordinates are filtered by inclusive circle membership. Unverified/approximate source points inside the circle are uncertain candidates, never verified membership. Municipality-only offers are included when their known municipality intersects the circle, regardless of the representative point. Unknown-location candidates require saved discovery evidence associating them with this area or an intersecting source query; do not return every unknown listing in the installation. A known precise outside point overrides broad query membership and is excluded. Municipality identity/intersection and representative-point provenance come from a documented reference or adapter evidence; absent evidence is unsupported coverage, not invented geography.

Map fixtures consume #5's four location variants. Display `distanceKm` only for verified positions; for unverified pins an optional coordinate distance must be labeled approximate and must not replace the unknown true distance. Municipality summaries and unknown-location entries have no house distance. Apply Show unavailable before grouping/counting so a group count equals its visible listing IDs. Groups do not duplicate listings in the list. No listing-location inference or listing geocoding is introduced. Address/place lookup under #38 resolves only the selected-area center.

## Address and place-name search extension

[Spec #38](https://github.com/goncalvesjoao/open-akiya/issues/38) extends area selection with explicit address/place lookup and match selection. Choosing a match updates the center and map/circle/coordinate controls while preserving the accepted radius and Show unavailable setting. The existing SelectedArea and import API contracts remain unchanged. Lookup and match selection never start an import; running jobs retain their original areas.

Location-search geocoding is permitted solely for the user-selected center; listing positions remain source-provided and retain their uncertainty rules. Existing child-ticket geocoding exclusions still apply to those tickets; #38 owns this additive capability and is required for the expanded map acceptance. It can build on the synthetic map independently of the import runtime and live listing sources.

Testing confirmed by the user: React UI tests with a controlled location provider cover matching, ambiguity, no results, errors, stale responses, keyboard access and retaining valid selection. Extend one controlled Playwright map journey to verify result selection moves the map/circle with the radius preserved and no import request. No automated live geocoding requests. See #38 for the full acceptance scope and provider requirements.
