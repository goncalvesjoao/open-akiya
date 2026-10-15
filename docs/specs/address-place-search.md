# Search by address or place name to select an area

Spec [#38](https://github.com/goncalvesjoao/open-akiya/issues/38), part of #2 under #1.

## Problem Statement

Users know the address or name of an area they want to explore, but currently must navigate the map manually or enter latitude and longitude. Parent #1 and map spec #2 exclude geocoding, leaving no address or place-name search flow.

## Solution

Let users search for a Japanese address or place name, choose a matching location, and use it as the center of their selected area. Preserve the selected radius and the explicit action required to start an area import. Keep map selection and coordinate controls available.

## User Stories

1. As a user, I want to search by address, so that I can explore a familiar location without knowing coordinates.
2. As a user, I want to search by city, municipality, neighborhood or other supported place name, so that I can reach an area of interest quickly.
3. As a user, I want Japanese search text accepted, so that I can use local addresses and names.
4. As a user, I want Latin-script place queries supported where the provider recognizes them, so that I can search with familiar names.
5. As a user, I want clearly labeled matching locations with geographic context, so that I can distinguish similarly named places.
6. As a user, I want to explicitly choose a match, so that an ambiguous query does not silently select the wrong location.
7. As a user, I want the map, circle and coordinate controls to reflect my chosen location, so that the selected area is clear.
8. As a user, I want my radius preserved, so that finding a place does not change my requested search scope.
9. As a user, I want to adjust the center or radius afterwards, so that I can refine the selected area.
10. As a keyboard user, I want accessible search, result selection and status messages, so that I can choose a location without pointer gestures.
11. As a mobile user, I want usable search controls and readable matches, so that I can search on a small screen.
12. As a user, I want loading, no-match and provider-error states distinguished, so that I know whether to refine or retry my query.
13. As a user, I want failures, empty queries and dismissed results to retain my last valid selected area, so that unsuccessful searches do not disrupt exploration.
14. As a user, I want old responses prevented from overriding a newer search or area selection, so that delayed requests do not move my map unexpectedly.
15. As a user, I want location search to leave collection under my explicit control, so that looking up a place does not start an import.
16. As a local user, I want location-provider network requirements and attribution documented, so that I understand how lookup works.
17. As a user, I want coordinate and map selection to remain usable when location search is unavailable, so that a provider failure does not block exploration.
18. As a user, I want a place result treated as an area center rather than proof of listing availability or exact house locations, so that the map does not imply unsupported precision or source coverage.

## Implementation Decisions

- This is an additive child spec of #2 under #1. It extends area selection; it does not change import execution or listing normalization.
- Provide a labeled address/place query field and an explicit Search action. Do not require autocomplete or issue requests on every keystroke. Trim input and reject blank queries locally without provider requests.
- Support Japanese text and provider-supported Latin-script queries for locations in Japan. Keep current interface text English; preserve returned Japanese names. Do not add translation or an interface locale selector. Explain provider coverage limitations and distinguish location matches from supported listing-source coverage.
- Show a bounded set of matches with provider-supplied display names and municipality/prefecture/address context where available. Require explicit result selection, including a single match. Do not manufacture missing address detail or claim address-level accuracy for a municipality result.
- Selecting a valid match updates the existing selected-area center and synchronized map/circle/coordinate controls. Preserve the last accepted radius and Show unavailable setting. Retain existing finite WGS84 validation and positive radius of at most 10 km. Do not replace a circle with provider bounds or a municipality polygon.
- Typing, submitting, receiving matches or clearing/dismissing lookup does not alter the selected area. Only selecting a valid current match does. Invalid coordinates and provider errors retain the last valid area. Clear or invalidate stale match selections after a new query; ignore superseded responses, including after the user changes the area through other controls.
- Use a replaceable location-search provider boundary returning display labels, valid center points and any required attribution. Keep it separate from listing queries and bank adapters. No listing DTO, SelectedArea contract, job API or database migration is required.
- Choose and document a provider supporting the required Japanese search use cases during implementation. Verify its official usage terms, permitted local-app request transport, attribution, rate limits and credential handling before enabling it. Prefer an explicit-submit integration without a paid-service prerequisite. Respect provider limits, handle rate limiting as a recoverable failure, and do not expose secret keys in the browser. A provider requiring server-side secrets must use a local service; the synthetic map and existing controls remain usable without that service. Do not use unrestricted public autocomplete endpoints without permission.
- Document that search text is sent to the configured external provider and document setup/network requirements. Render provider text safely and retain required attribution. Automated tests use controlled responses rather than live lookup.
- Location lookup may make geocoding network requests; it never creates import jobs, scrapes banks or implies inventory. Selecting a match can read existing/synthetic listings through the established area-query boundary. Existing running jobs retain their immutable areas.
- Narrow the existing geocoding exclusion to listing-location inference. User-entered address/place lookup is allowed only for selecting the area center. Missing listing addresses or positions remain uninferred, and uncertainty labels and municipality summaries remain unchanged.
- Provide accessible labeled controls, keyboard-operable matches, visible focus and announced loading/empty/error states. Keep fallback map/coordinate controls operational during failures.

## Testing Decisions

- The user confirmed these seams before publication: existing React UI tests with a controlled location-search provider, plus one extension to the existing Playwright map journey.
- Test observable UI behavior through accessible queries and user interactions: Japanese and Latin-script queries, trimmed/blank input, explicit match choice, ambiguous matches, no matches, loading, errors/rate limits, invalid coordinates, retry, clearing, keyboard access, preserved radius/settings and last valid area.
- Exercise out-of-order responses and newer manual map/coordinate selection so stale lookups cannot change the area. Confirm choosing a result synchronizes coordinate controls and subsequent listing-query area without creating an import.
- Extend one deterministic browser journey to search and select a place, verify the actual map/circle moves with the retained radius, and verify usable mobile controls and no import request. Real map positioning/circle rendering needs browser layout; keep other state/error cases in simulated DOM tests.
- Follow the current React Testing Library/Vitest UI and Playwright map-testing precedent. Control tiles and provider responses; automated tests make no live geocoding or bank requests. Keep any provider transport checks at its public boundary, without testing internal component wiring.

## Out of Scope

- Geocoding or inventing listing positions, reverse geocoding, automatic device location, route planning and travel-time search.
- Mandatory autocomplete, guaranteed exhaustive address coverage, automatic translation, new listing filters or a Japanese interface locale.
- Starting collection on search/map movement, changing request budgets, source permissions, hosted deployment or requiring paid discovery services.

## Further Notes

- Update #1 and #2 and their repository copies to distinguish user location lookup from listing geocoding. Existing implementation tickets' geocoding exclusions continue to limit their own scope; they do not implement this new capability.
- Can build against the existing synthetic map without the import runtime or an enabled live listing source. Completion requires the agreed UI/browser checks and a documented permitted provider integration; fixture-only lookup is insufficient.
