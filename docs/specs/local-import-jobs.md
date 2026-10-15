# Local area import jobs and map progress

## Desktop runtime

Use Electron, React/TypeScript, a utility-process worker and worker-owned SQLite. Job operations cross a validated, context-isolated preload bridge; there is no local HTTP server. The renderer cannot access Node.js, SQL, source observations or arbitrary IPC. Closing the window keeps the application and imports running; reopening from the launcher restores the window. Explicit Quit stops scheduling and preserves committed work for recovery on restart. Cancelled work never resumes automatically. Sleep, shutdown and process crashes interrupt execution; no operating-system service or scheduling while fully exited is promised.

The full acceptance requirements below remain targets. The desktop foundation implements basic synthetic create/list/inspect/cancel/results operations, covering active-job attachment, independent request cancellation and restart recovery. Queued work can reuse successful checks obtained while waiting. It does **not** complete general freshness policy, manual-refresh follow-ups, bounded continuation or live-source activation. See [desktop runtime](../desktop-runtime.md) for the implementation boundary. Keep these gaps explicit rather than weakening acceptance.

Part of #1. Blocked by #2. This is an aggregate acceptance spec, implemented through the child specs below with parallel start conditions. Do not treat it as an additional independent implementation task.

## Implementation plan

See the [execution plan](../implementation-plan.md) for start conditions, shared contracts, and the distinction between parallel development and completion gates.

1. [#5 — Persistent local import runtime and normalized listing storage](https://github.com/goncalvesjoao/open-akiya/issues/5), able to start alongside #2 after contract alignment. Owns local startup, durable job API/state, synthetic adapter contract, normalized transactional storage, privacy, recovery, cancellation, and availability projection.
2. [#6 — Import cache reuse, refresh scheduling, and bounded continuation](https://github.com/goncalvesjoao/open-akiya/issues/6), blocked by #5 for integrated completion; can start once its contracts settle. Owns freshness and coverage reuse, manual-refresh intent, active-work attachment, fair request budgets, checkpoint semantics, continuation, and expired-cursor recovery.
3. [#7 — Map import controls, queue, progress, and result refresh](https://github.com/goncalvesjoao/open-akiya/issues/7), blocked by #2 and #6 for integrated completion; can start against agreed mock responses. Owns browser controls, visible queue and follow-ups, reconnectable progress, cached-result retention, terminal messages, and map/list integration.

All three children must pass their checks and the fixture-backed Electron renderer journey before this parent closes. The complete requirements below remain the acceptance contract; child specs allocate their implementation without removing requirements. Live-source spec #4 remains blocked by this parent.

## Problem Statement

Users need to request information for a selected area without blocking the UI or losing track of work. Repeated clicks, browser reloads, and overlapping searches must not multiply collection requests. The desktop foundation supplies basic synthetic jobs; the full policy and live-source requirements below remain unfinished.

## Solution

Connect the selected map area to a local, persistent import service. Users explicitly start a job, see progress, cancel work, reconnect after a reload, and see committed results on the map when the job ends. A synthetic source adapter exercises the entire flow without live scraping.

## User Stories

1. As a local user, I want documented desktop installation and launch, so that I can run the tool locally.
2. As a user, I want cached listings shown before collection, so that existing information is immediately useful.
3. As a user, I want freshness and coverage information, so that I can judge whether to request an update.
4. As a user, I want an explicit import button for my selected area, so that map movement does not collect information.
5. As a user, I want immediate acknowledgement, so that I know the request was accepted.
6. As a user, I want discovery, fetching, and saving progress, so that I understand ongoing work.
7. As a user, I want to keep using the map while the worker runs, so that the UI remains responsive.
8. As a user, I want the job's original area displayed after changing my selection, so that scope stays clear.
9. As a user, I want repeated requests to reuse work, so that double clicks do not duplicate collection.
10. As a user, I want cancellation, so that unnecessary requests stop.
11. As a user, I want progress restored after reload, so that I do not restart the job accidentally.
12. As a user, I want interrupted work to recover after restart, so that committed results are preserved.
13. As a user, I want the map and list refreshed when work ends, so that results become discoverable.
14. As a user, I want outcome counts, so that I know what was added or updated.
15. As a user, I want partial, failed, cancelled, and empty outcomes distinguished, so that coverage is not overstated.
16. As a user, I want my imported records retained locally, so that there is no central dataset upload.
17. As a maintainer, I want deterministic end-to-end fixtures, so that I can verify the workflow without live-source access.
18. As a user, I want credentials and raw errors kept out of browser responses, so that local backend privileges remain protected.
19. As a user, I want Refresh anyway to recheck recent results within traffic limits, so that I can explicitly request fresher information.
20. As a user, I want Continue search to resume a budget-limited search, so that I can retrieve more results without restarting completed work.
21. As a user, I want another area's request to enter a visible cancellable queue, so that I can plan searches without running workers concurrently.
22. As a user, I want saved listings visible during failed refreshes, so that temporary failures do not erase useful results.

## Implementation Decisions

- Use Electron with a React/TypeScript renderer, a TypeScript utility-process worker and embedded SQLite in the per-user application data directory. Installed users launch one desktop application; no Docker, Supabase, database server or Node.js installation is required. Keep work independent of renderer reloads and window visibility.
- Add create, inspect, cancel, and area-results API operations. Create validates center coordinates and radius greater than zero and at most 10 km in the worker, accepts an idempotency key, and immediately returns a persisted job ID or explicit cache/in-flight reuse outcome. Job input is immutable after creation.
- Support explicit manual refresh and search continuation through this API. Manual refresh bypasses area and listing-detail freshness, retaining active-work reuse and all traffic controls. Continue search creates a linked bounded job from saved progress and retains the original scope and accumulated coverage; incomplete, cancelled, or failed traversals cannot advance the completed discovery checkpoint. Cancelled work resumes only on user action.
- Treat invalid or expired continuation progress as a bounded discovery restart, preserving saved results and reusing identities/details under the request's freshness policy. Report why progress restarted. Do not mark an abandoned traversal complete or advance its checkpoint; the replacement traversal must independently satisfy coverage requirements.
- Persist refresh intent separately from the shared job so manual refresh attached to ordinary work cannot be satisfied by details that work skipped as fresh. After active work settles, queue the additional required rechecks in bounded follow-up jobs and expose the manual request as pending until those checks finish or report a partial/failed/cancelled outcome. Reuse successful checks performed since the manual request and deduplicate repeated refresh requests. Keep follow-up work visible and cancellable.
- Inspection exposes state, stage, timestamps, original area, meaningful counters, per-source outcomes, budget usage, and sanitized errors. States are queued, running, succeeded, partial, failed, and cancelled. Report counts rather than fabricated percentages. Persist enough UI context to reconnect to the job after reload; polling is sufficient.
- Persist jobs, source tasks, checkpoints, coverage records, retry times, and leases. Claim jobs transactionally under the single worker owner; recover interrupted running work on restart. Keep lease/ownership data if needed for future multiple workers. Enforce one executing import per installation initially. Cancellation stops scheduling outbound work and preserves completed transactions; inspect and cancel are idempotent.
- Present queued jobs with their immutable areas and allow cancellation before execution. Identical or fully covered requests attach to active work; other requests queue, including partially overlapping areas. Re-evaluate cache and reusable detail work when a queued job starts. Recovery may resume interrupted work but must not revive a user-cancelled job. An already-running request may settle during cancellation; report saved results.
- Define adapter discovery/detail/normalization contracts and implement a synthetic adapter that can deterministically simulate pagination, changes, delays, failures, and cancellation. Label fixture mode clearly. The next spec supplies the first live implementation.
- Build the versioned SQLite listing schema with provider-scoped stable source identities and observations, transaction type, separate integer sale yen and monthly rent yen, optional decimal areas, availability separate from editorial publication state, location precision/provenance, content hashes, and successful-check timestamps. Preserve Japanese originals, primary attribution and visibility decisions.
- Save validated source observations and listing projections atomically. A retry after commit cannot duplicate offers. Missing money remains null; free is explicit zero. Partial payloads cannot clear known valid fields. Distinct sale/rental offers remain distinct. Only proven cross-source matches may share a property projection.
- Operational tables and source observations stay inside the worker-owned SQLite database. The sandboxed renderer receives only approved listing/job projections through a narrow context-isolated preload bridge. Validate operation arguments in the worker and sender/frame identity in the main process; expose no SQL, filesystem, generic IPC or privileged credentials. Local imports do not alter editorial publication decisions.
- Confirmed configurable defaults: 24-hour complete-scan and individual listing-detail freshness; one request in flight per source host; minimum two-second source request interval unless stricter policy applies; 10 discovery-page requests and 100 detail requests per job across all sources, including retries. Budgets are configurable and exhaustion produces a partial outcome with Continue search when resumable. Synthetic tests exercise the same controls.
- Reserve a configurable, documented share of detail-request capacity for stale known-offer refreshes when both new and refresh work are pending. When the job budget permits, each class receives capacity; release unused reserved capacity to the other class. Carry deferred refresh work across continuations and use oldest successful-check time first so repeated discovery cannot starve the same old offers. The allocation stays inside the existing total detail-request limit, including retries; manual-refresh rechecks use the refresh allocation.
- Reuse complete cache coverage only for the same source set, filter semantics, and adapter versions. Geometric overlap is insufficient: require containment for full-area reuse, using geographic distances. Reuse candidate/detail work across partial overlaps without declaring unscanned areas complete. Attach to identical or fully covering in-flight work and prevent duplicate concurrent detail fetches.
- Keep previously saved listings visible during work and after failures, with actual successful-check timestamps. Refresh the map/list query on every terminal outcome, preserving committed partial results and selection. Follow the map contract for verified pins, unverified individual pins, municipality summary pins, and unknown-location candidates.
- Terminal messages distinguish Search finished, Partial results—continue search, Cancelled, and Failed. Explain added/updated counts, freshness, truncation, and source failures, with a persistent reminder that source coverage may be incomplete. A finished traversal is not a claim of exhaustive available homes.
- Preserve separate new-offer discovery and stale known-offer refresh tasks. Discovery checkpoints are scoped to the source, covered area/query, and adapter semantics, and advance only when the traversal completes across any continuations. The synthetic adapter must cover reliable ordering, equal-date ties, unsupported dates, and price changes to older offers.
- Hide explicitly unavailable offers from default results while retaining local history and Show unavailable. Preserve independent source observations so another current source can still support availability. Failed checks and scoped absence cannot hide a listing as withdrawn.
- A scoped or failed job cannot establish global absence. Never withdraw listings solely because a request omits them. Show a configuration error rather than successful empty results when no source is enabled.

## Testing Decisions

- Preserve the user-confirmed primary seam: job API with temporary SQLite databases and deterministic fixture adapters. Assert returned states, persisted results, coverage, and externally observed request counts; avoid queue implementation assertions.
- Extend the map spec's Electron renderer journey to select an area, start a job, see running progress, reload/reconnect, and see saved pins/list results after completion. Exercise partial failure and cancellation at the API seam rather than multiplying UI tests.
- Cover invalid radius without requests, repeated creation, cache containment versus overlap, version/source cache invalidation, failed scans not populating complete cache, retry budgets, restart after commit, interrupted ownership, cancellation races, and no-enabled-source errors.
- Verify manual refresh bypasses area/detail freshness without bypassing budgets or duplicating active work; queued jobs reuse newly completed work; cancellation never automatically resumes; and Continue search resumes cursors without prematurely completing coverage or advancing checkpoints. Verify older known offers refresh independently of early-stopped discovery, equal-date ties are retained, and a new area cannot reuse an unrelated checkpoint.
- Verify invalid/expired progress restarts discovery within budget, retains saved data, and does not duplicate records or advance incomplete checkpoints. Verify mixed new/stale workloads exercise reserved capacity, unused capacity is reusable, and deferred oldest refreshes remain eligible across continuations.
- Verify manual refresh joining an ordinary job that skipped recent details queues the missing rechecks, stays pending until its required work settles, reuses checks completed since its request, deduplicates repeated refreshes, and supports cancelling follow-up work without deleting saved results.
- Verify saved results survive refresh failure, terminal messaging distinguishes empty success from failure and truncation, and explicit withdrawal changes default visibility while Show unavailable retains access.
- Verify money semantics, coordinate uncertainty, preservation of moderation, and non-archival after scoped failures. Verify the preload exposes no operational-table reads or arbitrary writes, and untrusted frames cannot invoke job operations.
- Extend the SQLite worker tests. Use a controlled clock and deterministic network substitutes; automated tests need no live bank or tile-provider requests.

## Out of Scope

- Live-source collection, source permission negotiation, hosted deployment, multi-user authentication, nightly jobs, or nationwide discovery.
- Translation, image mirroring, fuzzy merging, and automatic withdrawal from search absence.

## Further Notes

- Depends on the map spec's area and result contracts. Completion requires the fixture-backed local workflow, not real bank access.
- Request budgets and cache age are initial configurable defaults, not source-approved limits. The parent spec remains the overarching product contract.

## Shared contract ownership

The concrete selected-area/query semantics are owned by #2; listing/results, durable request/job API, and adapter definitions/examples by #5; policy extensions and continuation/manual-refresh examples by #6. #7 consumes those contracts and #4 implements the same adapter boundary. Reuse these definitions and fixture recipes for the aggregate acceptance journey; this parent adds no competing wire contract. Existing scope, completion gates and testing seams remain unchanged.
