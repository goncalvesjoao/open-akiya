# Persistent local import runtime and normalized listing storage

Part of #3, under #1. Can start alongside #2 after area/listing contract alignment; no finished-map dependency. See the [implementation plan](../implementation-plan.md) for parallel start conditions and integration gates.

## Problem Statement

Users cannot run a persistent area import or safely retain results locally. Browser navigation, retries, and restarts must not lose or duplicate committed offers.

## Solution

Provide a local job API and worker that imports synthetic offers into local Supabase, reports durable job state, and supports cancellation and restart recovery. This is an independently verifiable API milestone before cache policies and UI integration.

## User Stories

1. As a local user, I want documented frontend, backend, and database startup, so that I can run the tool locally.
2. As a user, I want immediate acknowledgement, so that I know the request was accepted.
3. As a user, I want discovery, fetching, and saving progress, so that I understand ongoing work.
4. As a user, I want cancellation, so that unnecessary requests stop.
5. As a user, I want interrupted work to recover after restart, so that committed results are preserved.
6. As a user, I want outcome counts, so that I know what was added or updated.
7. As a user, I want partial, failed, cancelled, and empty outcomes distinguished, so that coverage is not overstated.
8. As a user, I want my imported records retained locally, so that there is no central dataset upload.
9. As a maintainer, I want deterministic end-to-end fixtures, so that I can verify the workflow without live-source access.
10. As a user, I want credentials and raw errors kept out of browser responses, so that local backend privileges remain protected.

## Implementation Decisions

- Use local Supabase Postgres and a local TypeScript backend/worker, independent of browser lifetime. Document Docker/Supabase prerequisites and one startup command after prerequisites are installed. Keep privileged credentials server-side, bind to loopback, validate mutation requests, and restrict origins.
- Add create, inspect, cancel, and area-results API operations. Create validates center coordinates and radius greater than zero and at most 10 km on the server, accepts an idempotency key, and immediately returns a persisted job ID or explicit cache/in-flight reuse outcome. Job input is immutable after creation.
- Inspection exposes state, stage, timestamps, original area, meaningful counters, per-source outcomes, budget usage, and sanitized errors. States are queued, running, succeeded, partial, failed, and cancelled. Report counts rather than fabricated percentages. Persist enough UI context to reconnect to the job after reload; polling is sufficient.
- Persist jobs, source tasks, checkpoints, coverage records, retry times, and leases. Claim jobs transactionally; reclaim expired leases on restart. Enforce one executing import per installation initially. Cancellation stops scheduling outbound work and preserves completed transactions; inspect and cancel are idempotent.
- Define adapter discovery/detail/normalization contracts and implement a synthetic adapter that can deterministically simulate pagination, changes, delays, failures, and cancellation. Label fixture mode clearly. The next spec supplies the first live implementation.
- Extend the existing listing schema with provider-scoped stable source identities and observations, transaction type, separate integer sale yen and monthly rent yen, optional decimal areas, availability separate from editorial publication state, location precision/provenance, content hashes, and successful-check timestamps. Preserve current listing IDs, Japanese originals, primary attribution, and visibility decisions through additive migrations.
- Save validated source observations and listing projections atomically. A retry after commit cannot duplicate offers. Missing money remains null; free is explicit zero. Partial payloads cannot clear known valid fields. Distinct sale/rental offers remain distinct. Only proven cross-source matches may share a property projection.
- Operational tables and raw observations are private with RLS and restricted grants. Browsers receive approved listing projections through the local API. Imported records may appear locally without making them publicly published or changing editorial status.
- Hide explicitly unavailable offers from default results while retaining local history and Show unavailable. Preserve independent source observations so another current source can still support availability. Failed checks and scoped absence cannot hide a listing as withdrawn.
- A scoped or failed job cannot establish global absence. Never withdraw listings solely because a request omits them. Show a configuration error rather than successful empty results when no source is enabled.
- The base API exposes durable queued/running/terminal states, bounded execution, and a replaceable adapter boundary. Policy-sensitive manual refresh and continuation operations are completed by the next child; document the API contract so that extension does not require another runtime.

## Testing Decisions

- Retain the user-confirmed job API seam with test Postgres and deterministic fixture adapters, plus the existing map browser journey where UI behavior is involved. Assert observable behavior, not implementation internals.
- Reject invalid areas without outbound requests; repeated idempotency keys reuse the same job; prove one executor, queued cancellation, lease expiry, recovery after commit, and that cancellation never automatically resumes.
- Verify normalized money, distinct offers, source uniqueness, private operational records, permitted local projections, explicit unavailable visibility, and preservation of moderation and valid data after malformed input.
- The repository currently has no job test precedent. Introduce only necessary tooling and use controlled clocks/network responses; automated checks make no live bank requests.

## Out of Scope

Cache reuse, conditional early stopping, continuation policies, manual-refresh follow-ups, and browser integration belong to the next two child specs. This milestone does not claim full parent completion.

- Hosted deployment, nightly or nationwide collection, paid discovery, translation, image mirroring, and fuzzy cross-source merging remain excluded.

## Further Notes

- Parent #3 retains the complete acceptance contract. This child owns the implementation decisions allocated here; completing it alone does not close #3. Existing map and live-source requirements remain in their respective specs.
