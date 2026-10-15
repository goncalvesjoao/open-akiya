# On-demand local akiya imports by map area

Category: enhancement. Triage role: ready-for-agent. Spec labels: spec and status/todo unless an existing status label applies. The user confirmed the testing approach before publication.

## Problem Statement

People exploring vacant homes in Japan need listings for an area they care about without manually searching multiple banks. A nationwide scheduled collector would request and retain information they may never use. Open Akiya currently has a landing page and a basic Supabase listings schema, but no interactive map, local job service, or ingestion adapters.

This is an open-source application people run locally. It is not a centrally deployed listing aggregator, and scraped datasets are not distributed with its code.

## Solution

A user selects a map point and a radius of at most 10 km, sees any cached listings and their freshness, and explicitly starts an import. A local backend gathers candidates through configured sources within a bounded request budget, saves normalized listings to the user's local database, and reports progress. When the job completes, the UI refreshes the selected area's results and explains additions, updates, incomplete coverage, and any failures.

Nearby cached results and overlapping in-flight requests are reused. Geographic source limitations are made visible: a bank that searches only by municipality may require broader discovery before filtering, and a radius cannot guarantee that every request is confined to that circle.

## User Stories

1. As a local user, I want documented setup for the app, backend, and database, so that I can run everything on my machine.
2. As a user, I want an interactive map, so that I can choose an area to explore.
3. As a user, I want to select a center and radius, so that I control the area requested.
4. As a user, I want a clearly displayed 10 km radius limit, so that I understand the maximum search scope.
5. As a user, I want invalid areas rejected before requests start, so that mistakes do not trigger collection.
6. As a user, I want to see cached results immediately, so that I can explore without waiting for another import.
7. As a user, I want the last successful check time, so that I can judge freshness.
8. As a user, I want to explicitly start collection, so that moving the map does not generate scraping requests.
9. As a user, I want immediate acknowledgement and a job identifier, so that I know my request was accepted.
10. As a user, I want understandable discovery, fetching, and saving progress, so that I know work is continuing.
11. As a user, I want to recover job progress after refreshing the page, so that I do not accidentally restart collection.
12. As a user, I want duplicate and overlapping work reused, so that repeated clicks do not multiply requests.
13. As a user, I want to cancel work, so that unnecessary requests stop promptly.
14. As a user, I want results to appear on the map when the job finishes, so that I can explore imported properties.
15. As a user, I want new, updated, and unchanged result counts, so that the outcome is clear.
16. As a user, I want failures distinguished from an empty search, so that I do not mistake a blocked source for no available homes.
17. As a user, I want partial results preserved and clearly identified, so that useful work is not lost.
18. As a user, I want approximate locations labeled and unmappable results accessible in a list, so that location uncertainty is clear.
19. As a user, I want original Japanese information and a source link, so that I can verify details.
20. As a user, I want sale prices, rent, unknown prices, and explicitly free properties distinguished, so that amounts are not misleading.
21. As a user, I want repeated imports to update existing records, so that my database does not accumulate duplicates.
22. As a user, I want source attribution retained for overlapping offers, so that I can trace where information came from.
23. As a user, I want no nationwide or nightly collection by default, so that activity follows my explicit requests.
24. As a maintainer, I want deterministic tests without live scraping, so that checks do not consume source requests.
25. As a maintainer, I want sources independently configurable and disabled when access is unresolved, so that the tool does not assume permission.
26. As a local user, I want my listings and credentials excluded from source distribution, so that my local data stays local.
27. As a user, I want unverified individual pins and counted municipality summary pins, so that uncertain locations remain explorable without implying accuracy.
28. As a user, I want Refresh anyway and Continue search, so that I can request fresher information or resume partial coverage within traffic limits.
29. As a user, I want a visible cancellable queue for other areas, so that only one import executes at a time.
30. As a user, I want unavailable offers hidden by default but retained locally, so that I can inspect their history when needed.

31. As a user, I want to find an address or place name and choose a match as my selected-area center, so that I do not need coordinates or manual map navigation.

## Implementation Decisions

- This is the parent product spec. The [implementation plan](../implementation-plan.md) defines parallel start conditions and integration gates for these child specs:
  1. [#2 — Map, listing pins, and bounded area selection](https://github.com/goncalvesjoao/open-akiya/issues/2).
  2. [#3 — Local area import jobs and map progress](https://github.com/goncalvesjoao/open-akiya/issues/3), dependent on #2; aggregate acceptance parent for implementation specs [#5](https://github.com/goncalvesjoao/open-akiya/issues/5) (persistent runtime/storage), [#6](https://github.com/goncalvesjoao/open-akiya/issues/6) (reuse/refresh/continuation), and [#7](https://github.com/goncalvesjoao/open-akiya/issues/7) (map UI integration).
  3. [#4 — First permitted live source for bounded area imports](https://github.com/goncalvesjoao/open-akiya/issues/4), dependent on #3.
- The map and fixture-backed flow can be completed independently of live-source authorization. Parent completion requires all three child specs; live-source acceptance remains unmet until an enabled permitted adapter is verified.
- Use the existing TypeScript frontend and local Supabase Postgres. Add a local TypeScript backend/worker that runs independently of browser navigation. Document local Supabase/Docker prerequisites and one startup command after prerequisites are installed. The synthetic map is independently releasable without the backend. Do not require a hosted Supabase project.
- Bind the backend to loopback by default, restrict accepted browser origins, and validate mutation requests. Keep privileged database credentials server-side. Browser clients cannot write operational tables.
- An area consists of a validated latitude/longitude center and a positive radius no greater than 10 km. Enforce the limit on both client and server. Show the circle on the map. Choose a map library and tile provider during implementation and document attribution and network requirements; local operation does not imply offline tiles.
- The job API supports create, inspect, and cancel. Create returns an accepted job identifier immediately or identifies reused cached/in-flight work. Inspection returns state, stage, meaningful counts, timestamps, source outcomes, truncation reasons, and sanitized errors. Do not invent a percentage when the total is unknown.
- Job states are queued, running, succeeded, partial, failed, and cancelled. Cancellation is idempotent and cooperative: stop new outbound requests, allow an active request/transaction to settle, preserve committed results, and report the cancellation.
- Persist jobs, source tasks, checkpoints, and leases in the local database. Restart recovery reclaims expired work without duplicating committed listings. A browser refresh reconnects to the stored job. Polling is sufficient for the first version.
- Confirmed configurable defaults: one executing import per local installation, one request in flight per source host, at least two seconds between source requests unless a stricter source policy applies, 24-hour complete-area and individual listing-detail freshness, and a per-job budget of 10 discovery-page requests and 100 detail requests across sources, including retries. These defaults do not establish source-approved limits.
- Manual refresh bypasses area and detail freshness, retaining traffic limits and reuse of active work. Other-area requests enter a visible cancellable queue; identical or fully covered requests attach to active work. Partially overlapping jobs reuse completed work when they start.
- Budget exhaustion retains partial results and saved progress and offers Continue search through another bounded job. Preserve the original scope and cumulative coverage. Do not mark coverage complete or advance a discovery checkpoint before the traversal completes. Cancelled jobs retain saved results and resume only on explicit user action; an active request may settle.
- If continuation progress is invalid or expired, restart discovery safely within the continuation job's budget, reuse saved identities and details according to freshness rules, and explain the restart. An invalid cursor cannot establish complete coverage or advance a checkpoint.
- Reserve part of the detail-request budget for stale known offers when both refresh and newly discovered detail work are pending. Use a documented configurable allocation, release unused capacity to the other work, and retain deferred refresh work for continuation so repeated discovery cannot starve older offers.
- Attaching manual refresh to ordinary active work must not silently satisfy it with details skipped as fresh. Track the manual request's refresh intent and queue any additional rechecks still required after active work completes, within bounded jobs. Expose that follow-up as pending; do not report the manual request finished while required rechecks remain. Reuse checks successfully performed since the manual request, and deduplicate repeated refresh requests.
- Keep saved listings visible during work and after failure with their actual last successful check. Report Search finished, Partial results—continue search, Cancelled, or Failed, with added/updated counts and a persistent source-coverage caveat. Job completion does not guarantee exhaustive available homes.
- Separate discovery of new offers from refreshes of stale known offers. Date-based early stopping is allowed only with verified descending date semantics and ordering, a completed checkpoint for the same source and covered area/query, and processing of equal-date ties with an overlap window. Initial scans have no checkpoint. Missing/unreliable dates disable the optimization; failed, cancelled, and truncated scans cannot advance it. Discovery stopping must not suppress older-offer detail refreshes.
- Reuse cache only when a successfully completed, sufficiently fresh scan covers the requested area for the same enabled sources, filters, and adapter versions. Overlap alone is not full coverage. Reuse known candidates and detail results for overlapping areas; attach identical or fully covered requests to in-flight jobs and avoid concurrent duplicate detail fetches.
- Source adapters separate discovery, detail retrieval, and deterministic normalization. Use source-native geographic filters when available. A municipality-only adapter may discover broadly within the request budget, but fetch details only for candidates known or plausibly likely to intersect the requested area. Disclose uncertainty and truncated coverage. Do not run unlimited municipal scans to satisfy a radius request.
- At Home and LIFULL HOME'S are candidate integrations, not presumed authorized sources. Record access method, source terms, permission evidence where applicable, attribution, reuse limits, and rate policy per adapter. Keep unresolved adapters disabled; never bypass access blocks. Ship synthetic fixtures rather than scraped datasets or images.
- One permitted municipal source is sufficient for the first live-source milestone if national-bank access remains unresolved. Explain unsupported areas rather than implying nationwide coverage.
- Extend the existing listing schema through migrations. Preserve Japanese text, primary source URL, editorial visibility, and existing identifiers. Add source identities unique within each provider, separate sale price and monthly rent, property type, optional floor/land area, availability independent of publication status, first/last seen and successful-check timestamps, location precision/provenance, and normalized content hashes.
- Normalize money to integer yen and areas to square metres. Missing prices are null; zero means explicitly free. Do not guess missing listing addresses or coordinates or geocode listing positions. User-entered address/place lookup for the selected-area center is allowed under #38. Show individual pins for source-provided positions, labeling unverified accuracy and approximate distance as applicable; distinguish them from verified in-radius positions.
- Offers with only a known municipality use a distinct municipality summary pin with a count and list for municipalities intersecting the circle. Use a documented representative point, possibly outside the circle, and explain that it is not a house location and distance from the selected center is unknown. Offers with neither usable coordinates nor municipality stay in an Unknown location list without a pin.
- Save source observations and public projections transactionally and idempotently. Preserve multiple source references for confirmed duplicate offers; uncertain cross-source matches remain separate. Sale and rental offers cannot overwrite each other. Partial responses cannot erase known values or moderation decisions.
- A scoped scan cannot establish global withdrawal. Do not archive records because they disappear from search results, fail to load, or lie outside a later request. Handle explicit unavailable statuses independently and preserve provenance.
- Explicit withdrawal hides unavailable offers from the default map/list while retaining local history behind Show unavailable. Preserve another source's current availability evidence; failed checks alone cannot hide offers as withdrawn.
- Handle timeouts, retries with bounded backoff, Retry-After, parser failures, cancellation, and source blocks distinctly. Cap attempts and request budgets, including retries. Sanitize displayed text and validate source hosts and redirects.
- Store collected data locally; distribute no collected dataset, photos, or source descriptions with the repository. Translation, image copying, and public dataset export are not part of this feature.

## Testing Decisions

- Confirmed primary seam: the local job API exercised against a test database and deterministic fixture-backed source adapters. Assert externally observable jobs, saved records, request counts, and outcomes rather than internal function calls or queue structure.
- Add one browser-level journey that selects an area, starts collection, observes running state, and sees saved results on the map. Include refresh/reconnection at this seam where practical.
- The repository currently has no test suite or ingestion test precedent. Introduce only the tooling needed for these observable behaviors; keep live source network calls out of automated tests.
- Cover invalid radius rejection without outbound requests; idempotent retries and double clicks; full cache containment versus partial overlap; budget exhaustion; cancellation; crash/restart recovery; one source failing while another succeeds; successful empty results versus failure; and unauthorized backend mutation attempts.
- Cover queue cancellation and active-work reuse; manual refresh of recent area/detail caches; bounded continuation without premature coverage/checkpoint advancement; equal-date ties and unrelated-area checkpoints; older known-offer updates after discovery stops; and previously saved results surviving refresh failure.
- Cover expired/invalid continuation cursors with safe bounded restart and no duplicate records; mixed new/stale work with reserved refresh capacity and unused-capacity reuse; and manual refresh attaching to ordinary work that skipped fresh details, ensuring missing rechecks queue without premature success or duplicate requests.
- Verify unverified individual pin labels, municipality summary counts and representative points outside the circle, unknown-location lists, Show unavailable, and truthful terminal messages. Use controlled fixtures without live requests.
- Verify normalization with representative source-shaped fixtures for sale, rent, free, unknown price, missing coordinates, approximate coordinates, and changed values. Assert that a failed/partial/scoped scan cannot withdraw unrelated listings or erase existing valid data.
- Verify freshness and coverage using a controlled clock. Verify jobs remain inspectable after reload and credentials/raw source errors do not reach the UI. Separately perform a small manual live pilot only after access is resolved, checking source attribution, geographic capabilities, and actual request volume.

## Out of Scope

- Hosted deployment, shared multi-user service, or centrally published dataset.
- Nightly schedules, nationwide crawls, or automatic collection on map movement.
- Guaranteed complete inventory or guaranteed precise radius coverage from approximate source locations.
- Bypassing access restrictions, CAPTCHA, authentication requirements, or source blocks.
- Translation services, photo mirroring, user accounts, geocoding listing positions, advanced listing filters beyond Show unavailable, automatic fuzzy property merging, and automatic archival based on search absence.
- Paid discovery services.

## Further Notes

- This replaces the earlier nightly-worker proposal. That document remains background research, not the current execution architecture.
- The design interview confirmed the 10 km limit, freshness and request-budget defaults, queue/continuation behavior, location model, and unchanged testing seams. Implementation must verify source-specific capabilities before enabling optimizations.
- Source context: [MLIT national-bank overview](https://www.mlit.go.jp/totikensangyo/const/sosei_const_tk3_000131.html), [At Home terms](https://www.akiya-athome.jp/contents/index/?page=kiyaku), and [LIFULL terms](https://www.homes.co.jp/kiyaku/).
- The repository uses GitHub Issues and the canonical triage-label vocabulary.

## Shared contract ownership

Concrete contract alignment lives in existing children: #2 owns selected area/query semantics, #5 owns listing/results, job API and source adapter definitions, #6 owns policy extensions and response scenarios, and #7/#4 consume them. These documentation contracts permit parallel synthetic map/backend and mock UI work; they do not claim runtime implementation or source authorization. The implementation plan retains the integration gates. No additional alignment ticket is needed.

## Address and place-name search extension

[Spec #38](https://github.com/goncalvesjoao/open-akiya/issues/38) extends area selection with explicit address/place lookup and match selection. Choosing a match updates the center and map/circle/coordinate controls while preserving the accepted radius and Show unavailable setting. The existing SelectedArea and import API contracts remain unchanged. Lookup and match selection never start an import; running jobs retain their original areas.

Location-search geocoding is permitted solely for the user-selected center; listing positions remain source-provided and retain their uncertainty rules. Existing child-ticket geocoding exclusions still apply to those tickets; #38 owns this additive capability and is required for the expanded map acceptance. It can build on the synthetic map independently of the import runtime and live listing sources.

Testing confirmed by the user: React UI tests with a controlled location provider cover matching, ambiguity, no results, errors, stale responses, keyboard access and retaining valid selection. Extend one controlled Playwright map journey to verify result selection moves the map/circle with the radius preserved and no import request. No automated live geocoding requests. See #38 for the full acceptance scope and provider requirements.
