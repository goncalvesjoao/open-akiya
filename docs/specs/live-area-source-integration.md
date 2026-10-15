# First permitted live source for bounded area imports

Part of #1. Source/access investigation can start immediately, with adapter development after contract alignment. The live pilot and integrated completion are blocked by #3. See the [implementation plan](../implementation-plan.md).

## Problem Statement

The fixture-backed workflow does not retrieve actual properties. Users need a live source that supports bounded area discovery and produces reliable normalized data without unbounded requests, misleading coverage, or an assumed right to reuse third-party content.

## Solution

Implement and verify one permitted live source through the established adapter contract. Display its geographic limitations and coverage, reuse cached work, respect request budgets, and save traceable property facts locally. At Home and LIFULL HOME'S are research candidates; a suitable municipal feed is also acceptable.

## User Stories

1. As a local user, I want documented source configuration, so that I can enable a supported live integration.
2. As a user, I want to see which source will be queried, so that collection is understandable.
3. As a user, I want unresolved integrations disabled with an explanation, so that the tool does not imply permission.
4. As a user, I want discovery scoped as closely as the source supports, so that requests remain relevant.
5. As a user, I want municipality-only search limitations disclosed, so that a radius does not promise unsupported precision.
6. As a user, I want new and stale details fetched selectively, so that repeated imports minimize traffic.
7. As a user, I want source references and Japanese originals retained where permitted, so that I can verify facts.
8. As a user, I want correct prices, units, and locations, so that normalization is trustworthy.
9. As a user, I want unavailable and uncertain offers distinguished, so that results do not overstate availability.
10. As a user, I want failed records isolated without losing valid results, so that partial imports remain useful.
11. As a user, I want blocked sources to stop gracefully, so that the worker does not attempt circumvention.
12. As a user, I want budget and pagination limits explained, so that I know when the area was only partly checked.
13. As a user, I want repeat imports to update rather than duplicate offers, so that the local database stays coherent.
14. As a user, I want uncertain locations separated from precise in-radius pins, so that the map stays honest.
15. As a maintainer, I want a small documented live pilot, so that source behavior and request volume are demonstrated.
16. As a maintainer, I want parser checks without live scraping, so that routine development generates no collection traffic.
17. As a user, I want discovery to stop safely at a verified date boundary, so that repeated searches avoid unnecessary pages without skipping unseen offers.
18. As a user, I want older known offers refreshed separately, so that price changes and withdrawals are not missed by discovery optimizations.
19. As a user, I want an incomplete source scan to resume on request, so that a request budget does not force repeated collection of the same pages.

## Implementation Decisions

- Select one source after confirming supported access, geography, stable IDs, pagination, field availability, and reuse conditions. Prefer an approved API/feed/export. An official municipal source is acceptable if national-bank access is unresolved. Do not enable a candidate simply because its pages are public.
- Record terms/access URLs, review date, permitted facts/content, attribution, retention/removal obligations, and source rate limits. Collection, local storage, translation, photos, and redistribution are separate rights. Unresolved integrations stay disabled with an actionable configuration message; permission outreach is not automatic.
- Implement discovery, detail retrieval, and normalization behind the existing worker adapter contract. Require stable source identity or a documented canonical-URL fallback. Save adapter version and field provenance. Changes to query or parser semantics invalidate affected complete-coverage cache entries.
- Use native geographic filters when available. For municipal search, identify intersecting municipalities using an explicitly documented boundary/reference source or supported source filter. Broader discovery remains within job budgets; fetch details only for geographically relevant or plausibly relevant candidates. Unknown locations remain uncertain. If the necessary geographic mapping is unavailable, report unsupported coverage rather than silently scanning the country.
- Follow pagination only up to configured limits and source completeness signals. Track cursors and deduplicate candidate IDs across pages. Do not call a scan complete after timeout, missing page, result cap, or parser failure. Search index discovery is never evidence of exhaustive inventory.
- Enable date-based early stopping only when the adapter verifies reliable descending date semantics, ordering, and pagination, with a completed checkpoint for the same source, covered area/query, and adapter semantics. Record whether the date means publication or modification; publication-only ordering cannot establish unchanged older offers. Consume equal-date ties and use an overlap window. A newest record from another area is not a checkpoint. Missing dates or unsupported ordering disable this optimization.
- Initial discovery has no completed checkpoint. Persist resumable progress on budget exhaustion and implement explicit Continue search through the worker's bounded jobs; never advance a checkpoint for a partial, failed, or cancelled traversal. Mark traversal coverage complete only after all required discovery work settles, including continuations.
- Validate source continuation cursors and their scope/version when resuming. If a cursor expires or source changes invalidate it, surface a restart reason and restart discovery within the current job budget. Reuse saved source identities/details under the request's freshness policy; never infer coverage from an invalid cursor or advance the abandoned traversal's checkpoint.
- Reuse fresh details and source-supported update markers or conditional requests. If no change signals exist, recheck stale details within the budget and describe the resulting freshness limit. Do not treat search snippets as authoritative prices, addresses, or availability.
- Keep stale known-offer refreshes separate from new-offer discovery so early stopping cannot suppress older price/status changes. Apply the confirmed 24-hour detail freshness across areas; manual refresh bypasses freshness while retaining request budgets, pacing, and active-work reuse.
- Supply refresh candidates and successful-check timestamps to the worker's reserved-budget allocation so newly discovered offers cannot consume all capacity ahead of stale known offers. Respect oldest-first deferred refreshes and the overall request cap. When ordinary active work skipped fresh details, retain the manual refresh intent and perform missing rechecks through the worker's visible bounded follow-up jobs; a skipped detail is not a completed manual recheck.
- Apply the worker's per-host concurrency, pacing, retry, cancellation, and total-request budgets. Honor Retry-After. Source-specific stricter limits override defaults. On access blocks, stop and report; do not rotate identities or bypass challenges. Validate target hosts and redirects before fetching.
- Convert documented money and area units deterministically, preserve Japanese originals only where permitted, and quarantine ambiguous fields or template changes. Never infer an exact home address from a municipal centroid. Explicit unavailability may update the source observation; another current source may still support availability.
- Preserve source-provided coordinates and their accuracy/provenance so the map can show individual pins labeled unverified or approximate. Distinguish coordinates representing only a municipality: provide municipality identity for summary grouping rather than treating its office/centroid as a house. Use a documented representative point for intersecting municipality groups, including when that point lies outside the circle; explain unknown distances. No geocoding is required. Unknown municipality and position remain list-only candidates.
- Explicitly withdrawn offers remain saved but are hidden from default results and accessible through Show unavailable; missing or failed checks are not withdrawal evidence. Explain unsupported geographic areas. One permitted municipal feed completes the source milestone when national-bank access remains unresolved.
- Save through the existing transactional normalization/upsert boundary. Keep one-source retries idempotent and preserve known values, local moderation, original URLs, and different transaction offers. Incomplete scans or missing search results never imply withdrawal.
- Run a small manually initiated pilot after access is resolved. Report tested area, enabled source/access method, pages/details/retries, new/changed/rejected counts, location uncertainty, elapsed time, cache reuse on repetition, and coverage limitations. Publish no collected dataset or restricted screenshots in the repository.

## Testing Decisions

- Reuse the confirmed job API seam, substituting source-shaped synthetic HTTP responses behind the real adapter. Verify saved results, counts, failures, and request bounds rather than parser internals.
- Exercise paginated duplicates, changed and unknown prices, explicit free, rentals, unit conversion, stale details, missing/approximate coordinates, malformed templates, source blocks, Retry-After, budget exhaustion, and cancellation.
- Verify a partial municipal scan is not recorded as complete coverage, precise out-of-radius offers do not become in-radius pins, and unknown coordinates remain accessible as uncertain candidates.
- Verify initial scans do not stop against unrelated database dates, equal-date ties are processed, unreliable ordering disables early stopping, and partial/cancelled/failed traversals never advance completed checkpoints. Verify saved continuation progress and older-offer changes after discovery stops.
- Verify manual refresh bypasses recent detail freshness within request budgets; source locations produce appropriately labeled individual pins or municipality groups; and explicit withdrawal remains accessible through Show unavailable.
- Add source-shaped fixtures for expired/invalid cursors and changing pagination, proving safe bounded restart and identity reuse without false coverage. Verify mixed discovery/refresh workloads respect reserved capacity, and manual refresh attached to ordinary work performs the additional required checks without duplicate fetching or premature success.
- Verify repeated runs do not duplicate source offers, failed payloads preserve valid records, and scoped omission does not withdraw listings. Routine tests use no live provider requests.
- The parent-approved browser journey already tests map completion. Reuse it with deterministic adapter responses; the small manual live pilot provides the evidence specific to this source.

## Out of Scope

- Integrating both national banks in this first-source milestone, nationwide guarantees, scheduled imports, and public dataset hosting.
- Bypassing access blocks, copying unlicensed photos/descriptions, automated translation, and fuzzy cross-source merges.
- Paid discovery services and automatic source outreach.

## Further Notes

- Depends on the map and local-job specs. This spec cannot be declared complete with only a disabled adapter or fixture implementation: one permitted live source and the documented pilot are required.
- Primary research references: [MLIT national banks](https://www.mlit.go.jp/totikensangyo/const/sosei_const_tk3_000131.html), [At Home terms](https://www.akiya-athome.jp/contents/index/?page=kiyaku), and [LIFULL terms](https://www.homes.co.jp/kiyaku/). Recheck applicable conditions during source onboarding.
- [LIFULL municipality results](https://www.homes.co.jp/akiyabank/kanagawa/chigasaki/) expose separate new-arrival and update-date sorting; this alone does not establish ordering or timestamp guarantees. The design interview confirmed conditional early stopping, not an assumption that either national bank currently supports it safely.

## Shared contract handoff and remaining source decisions

Consume #2's area/query semantics, #5's listing projection and internal source-adapter contract, and #6's cursor/checkpoint/manual-refresh policies. Source-native evidence normalizes into those observations; do not create a parallel live-only job or map DTO. Use their concrete synthetic request/response recipes with source-shaped fixture evidence. The nightly-plan document is background; its schedules, absence-based reconciliation and geocoding suggestions do not override these on-demand specs.

Source/access investigation remains open: select a permitted source/access method and establish stable offer IDs, actual geography, request limits, retained fields, and ordering/cursor evidence before enabling it. Municipality adapters also need documented boundary/intersection evidence and representative-point provenance; use synthetic geometry for parallel fixture work. Recommend an official permitted municipal feed if national-bank access stays unresolved, as already allowed. A source unable to establish geographic support reports unsupported coverage instead of discovering nationwide. These are live-source gates, not blockers for #2/#5 synthetic work. Any required expansion of product scope or rights beyond the confirmed local facts-only import returns to the user; routine library, transport, reference-format and storage choices stay with implementation under the established constraints. No new product decision is needed to start map/backend work.
