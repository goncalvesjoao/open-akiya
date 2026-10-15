# Import cache reuse, refresh scheduling, and bounded continuation

## Desktop runtime

Use Electron, React/TypeScript, a utility-process worker and worker-owned SQLite. Job operations cross a validated, context-isolated preload bridge; there is no local HTTP server. The renderer cannot access Node.js, SQL, source observations or arbitrary IPC. Closing the window keeps the application and imports running; reopening from the launcher restores the window. Explicit Quit stops scheduling and preserves committed work for recovery on restart. Cancelled work never resumes automatically. Sleep, shutdown and process crashes interrupt execution; no operating-system service or scheduling while fully exited is promised.

The full acceptance requirements below remain targets. The desktop foundation implements basic synthetic create/list/inspect/cancel/results operations and explicit bounded continuation, covering active-job attachment, independent request cancellation and restart recovery. Queued work can reuse successful checks obtained while waiting. It does **not** complete general freshness policy, manual-refresh follow-ups, live-source activation. See [desktop runtime](../desktop-runtime.md) for the implementation boundary. Keep these gaps explicit rather than weakening acceptance.

Part of #3, under #1. Can start once #5 job/adapter contracts settle; integrated completion is blocked by #5. Can overlap #7 using agreed API fixtures. See the [implementation plan](../implementation-plan.md).

## Problem Statement

Repeated and overlapping searches can waste requests, while early stopping, expired cursors, or shared manual refreshes can incorrectly skip required work.

## Solution

Extend the persistent job API with freshness-aware work reuse, manual refresh intent, fair request allocation, safe checkpoints, and explicit bounded continuation using deterministic sources.

## User Stories

1. As a user, I want cached listings shown before collection, so that existing information is immediately useful.
2. As a user, I want freshness and coverage information, so that I can judge whether to request an update.
3. As a user, I want repeated requests to reuse work, so that double clicks do not duplicate collection.
4. As a user, I want Refresh anyway to recheck recent results within traffic limits, so that I can explicitly request fresher information.
5. As a user, I want Continue search to resume a budget-limited search, so that I can retrieve more results without restarting completed work.
6. As a user, I want another area's request to enter a visible cancellable queue, so that I can plan searches without running workers concurrently.
7. As a user, I want saved progress to survive a restart, so that repeated work stays bounded.
8. As a user, I want failures distinguished from complete coverage, so that outcomes remain trustworthy.

## Implementation Decisions

- Support explicit manual refresh and search continuation through this API. Manual refresh bypasses area and listing-detail freshness, retaining active-work reuse and all traffic controls. Continue search creates a linked bounded job from saved progress and retains the original scope and accumulated coverage; incomplete, cancelled, or failed traversals cannot advance the completed discovery checkpoint. Cancelled work resumes only on user action.
- Treat invalid or expired continuation progress as a bounded discovery restart, preserving saved results and reusing identities/details under the request's freshness policy. Report why progress restarted. Do not mark an abandoned traversal complete or advance its checkpoint; the replacement traversal must independently satisfy coverage requirements.
- Persist refresh intent separately from the shared job so manual refresh attached to ordinary work cannot be satisfied by details that work skipped as fresh. After active work settles, queue the additional required rechecks in bounded follow-up jobs and expose the manual request as pending until those checks finish or report a partial/failed/cancelled outcome. Reuse successful checks performed since the manual request and deduplicate repeated refresh requests. Keep follow-up work visible and cancellable.
- Present queued jobs with their immutable areas and allow cancellation before execution. Identical or fully covered requests attach to active work; other requests queue, including partially overlapping areas. Re-evaluate cache and reusable detail work when a queued job starts. Recovery may resume interrupted work but must not revive a user-cancelled job. An already-running request may settle during cancellation; report saved results.
- Confirmed configurable defaults: 24-hour complete-scan and individual listing-detail freshness; one request in flight per source host; minimum two-second source request interval unless stricter policy applies; 10 discovery-page requests and 100 detail requests per job across all sources, including retries. Budgets are configurable and exhaustion produces a partial outcome with Continue search when resumable. Synthetic tests exercise the same controls.
- Reserve a configurable, documented share of detail-request capacity for stale known-offer refreshes when both new and refresh work are pending. When the job budget permits, each class receives capacity; release unused reserved capacity to the other class. Carry deferred refresh work across continuations and use oldest successful-check time first so repeated discovery cannot starve the same old offers. The allocation stays inside the existing total detail-request limit, including retries; manual-refresh rechecks use the refresh allocation.
- Reuse complete cache coverage only for the same source set, filter semantics, and adapter versions. Geometric overlap is insufficient: require containment for full-area reuse, using geographic distances. Reuse candidate/detail work across partial overlaps without declaring unscanned areas complete. Attach to identical or fully covering in-flight work and prevent duplicate concurrent detail fetches.
- Preserve separate new-offer discovery and stale known-offer refresh tasks. Discovery checkpoints are scoped to the source, covered area/query, and adapter semantics, and advance only when the traversal completes across any continuations. The synthetic adapter must cover reliable ordering, equal-date ties, unsupported dates, and price changes to older offers.
- Own policy-sensitive API completion for manual refresh, search continuation, active-work attachment, and checkpoint/coverage semantics. Apply the established persistent runtime and transactional storage boundary.

## Testing Decisions

- Retain the user-confirmed worker API seam with temporary SQLite databases and deterministic fixture adapters, plus the existing map Electron renderer journey where UI behavior is involved. Assert observable behavior, not implementation internals.
- Verify area containment versus mere overlap, source/filter/version invalidation, cache re-evaluation when queued work begins, and reuse of individual listing details within 24 hours.
- Verify reserved refresh capacity, oldest-first deferred work, release of unused capacity, retry accounting, and total discovery/detail caps with mixed new and stale offers.
- Verify initial scans and unrelated scopes cannot reuse checkpoints; consume equal-date ties; disable early stopping for unreliable dates; preserve older-offer refreshes; never advance checkpoints after partial, cancelled, or failed traversals.
- Verify Continue search retains progress across bounded jobs, invalid cursors trigger safe bounded restarts without duplicate records or false coverage, and manual refresh attached to ordinary work queues missing rechecks without premature success.
- Extend the SQLite worker tests and Electron end-to-end journey with only necessary tooling and use controlled clocks/network responses; automated checks make no live bank requests.

## Out of Scope

Map UI integration and live source retrieval are separate milestones. Reuse the existing API and fixture-adapter seams rather than introducing a parallel worker.

- Hosted deployment, nightly or nationwide collection, paid discovery, translation, image mirroring, and fuzzy cross-source merging remain excluded.

## Further Notes

- Parent #3 retains the complete acceptance contract. This child owns the implementation decisions allocated here; completing it alone does not close #3. Existing map and live-source requirements remain in their respective specs.

## Shared policy extensions and response examples

Contract alignment, 2026-10-15. Extend #5's `ImportRequest`, `ImportJob`, `Coverage` and operations; do not introduce another API or DTO. Area input is owned by #2. This section specifies policy, not implemented behavior. All example times and source IDs are synthetic. Snapshot replacement objects below expand against #5's complete queued job example; these are fixture recipes for full inspection responses, never mutation responses.

### Scope, freshness and bounded work

`Coverage.status` is discovery coverage for the requested area under the stored source/query semantics. `complete` never means complete real-world inventory. Fresh cache reuse additionally requires successful required detail work, a covering completed job, and a nonexpired `freshUntil`. Both freshness defaults are 24 hours; exactly at expiry work is stale. A prior successful check may remain displayed during a later partial/failed refresh, but that failed attempt cannot extend freshness. Returned caveats explain unsupported geography, municipality breadth, incomplete discovery and source failures. Source failures cannot produce a new complete reusable area cache.

Scope fingerprints include enabled source IDs, adapter/query versions, geographic reference version and fixed discovery filters. Show unavailable is a presentation filter and does not trigger collection or invalidate discovery. Full-area containment uses `distance(centers) + requestedRadius <= coveringRadius`; overlap alone is insufficient. Composite coverage needs evidence of full union coverage, so the initial implementation should prefer a single covering completed scope rather than infer coverage from bounding boxes. Re-evaluate reuse at queue execution time. Return requested area on the request/results, covering area on an attached job.

Recommend a configurable default refresh reservation of 25% of the detail budget (25 of 100), with at least one slot per class when both are pending and the budget is at least two. Release unused capacity; retries count in the same class and total cap. A one-request budget alternates carried deferred classes across explicit continuations, retaining oldest-check ordering within refresh work. This is a technical scheduling default, not an increase to the agreed budget or a source-approved traffic policy. Deferred work is durable. Exhausting a bounded follow-up yields partial and requires explicit Continue search; do not spawn an endless chain of automatic bounded jobs.

A completed discovery checkpoint is private `{sourceId, queryKey, adapterVersion, dateField, boundaryAt, overlapSeconds, completedAt}`. It can be used only for that covered query with verified descending semantics. Reprocess equality and the overlap window before stopping. Missing dates/order evidence disable the optimization; older-offer refresh remains independent. Advance only after required traversal work commits across continuations. Invalidating a cursor abandons that traversal; only a separately completed replacement can advance its checkpoint. Clients never supply checkpoint dates or adapter cursors.

### Create, cache and attachment

`createImportRequest(input)` accepts the #5 base body or `{area, intent:'manual_refresh'}`. Continuation accepts `{intent:'continue', fromJobId}` and derives area, source scope, pending refresh intent and cumulative progress from that job. Do not accept a replacement area with continuation. Each action supplies an idempotency key. A continuation from an active job rejects with `JOB_NOT_TERMINAL`; no saved or restartable work rejects with `NOT_CONTINUABLE`. Concurrent/retried continuations from the same progress generation reuse the already-created continuation rather than double-schedule it. Changed source semantics require safe restart of affected discovery with an explanation; unresolved/disabled source scope is a configuration failure rather than silently complete coverage.

A cached ordinary import resolves, for example:

```json
{
  "id": "request-cache",
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "intent": "import",
  "state": "succeeded",
  "disposition": "cached",
  "jobIds": ["job-1"],
  "pendingFollowUp": false,
  "createdAt": "2026-10-15T01:00:00Z",
  "finishedAt": "2026-10-15T01:00:00Z",
  "error": null
}
```

The linked succeeded job is the covering check; area-results exposes its actual check time. Manual refresh cannot use this disposition. An identical or fully covering running job instead resolves with `disposition:'attached'`, that job's ID and a queued/running request state. Partial overlap creates a queued job; reusable candidates/details are reconsidered when it starts. Recover by persisted request ID, then inspect its job IDs. Pending state is persisted in worker-owned SQLite, not inferred from renderer memory. No response claims manual completion just because the attached ordinary job finished.

### Partial results and explicit continuation

Full shared inspection/request fixtures for this subset are in `src/shared/continuation-fixtures.ts`. Runtime verification is in `src/main/continuation.test.ts`.

`inspectImport("job-1")` after discovery budget exhaustion returns #5's base snapshot with:

```json
{
  "state": "partial",
  "stage": "finished",
  "startedAt": "2026-10-15T00:00:01Z",
  "finishedAt": "2026-10-15T00:00:30Z",
  "counts": {
    "discovered": 3,
    "checked": 2,
    "added": 2,
    "updated": 0,
    "unchanged": 0,
    "rejected": 0
  },
  "budget": {
    "discoveryUsed": 10,
    "discoveryLimit": 10,
    "detailUsed": 2,
    "detailLimit": 100
  },
  "sources": [
    {
      "sourceId": "fixture",
      "state": "partial",
      "coverage": "partial",
      "error": null
    }
  ],
  "coverage": {
    "status": "partial",
    "lastSuccessfulCheckAt": null,
    "freshUntil": null,
    "scopeKey": "fixture-scope-v1",
    "caveats": ["Discovery budget exhausted; saved results retained"]
  },
  "reasons": ["DISCOVERY_BUDGET_EXHAUSTED"],
  "continuation": {
    "available": true,
    "fromJobId": null,
    "restarted": false,
    "restartReason": null
  }
}
```

The associated request is partial with finishedAt `2026-10-15T00:00:30Z`. `createImportRequest(input)`, `idempotencyKey: "sample-continue-1"`:

```json
{ "intent": "continue", "fromJobId": "job-1" }
```

202 response:

```json
{
  "id": "request-2",
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "intent": "continue",
  "state": "queued",
  "disposition": "continued",
  "jobIds": ["job-2"],
  "pendingFollowUp": false,
  "createdAt": "2026-10-15T00:01:00Z",
  "finishedAt": null,
  "error": null
}
```

`inspectImport("job-2")` uses the base queued snapshot with `id:'job-2'`, createdAt `2026-10-15T00:01:00Z`, zero job-local counts/budget use, partial coverage inherited from saved traversal and `continuation:{available:false,fromJobId:'job-1',restarted:false,restartReason:null}`. Budget limits reset per job; identities, deferred refreshes and traversal progress persist. The original job remains partial and immutable. `available` becomes true on a terminal job only when there is explicit resumable or restartable pending work; UI offers Continue search for cancelled/failed jobs too when this flag is true. No automatic resume of user-cancelled work.

### Expired-cursor bounded restart

If adapter discovery rejects saved progress, `inspectImport("job-2")` returns this running snapshot replacement (job-2 identity/time as above):

```json
{
  "state": "running",
  "stage": "discovering",
  "startedAt": "2026-10-15T00:01:01Z",
  "budget": {
    "discoveryUsed": 1,
    "discoveryLimit": 10,
    "detailUsed": 0,
    "detailLimit": 100
  },
  "sources": [
    {
      "sourceId": "fixture",
      "state": "running",
      "coverage": "partial",
      "error": null
    }
  ],
  "coverage": {
    "status": "partial",
    "lastSuccessfulCheckAt": null,
    "freshUntil": null,
    "scopeKey": "fixture-scope-v1",
    "caveats": [
      "Saved cursor expired; discovery restarted within this job budget"
    ]
  },
  "reasons": ["CURSOR_EXPIRED"],
  "continuation": {
    "available": false,
    "fromJobId": "job-1",
    "restarted": true,
    "restartReason": "CURSOR_EXPIRED"
  }
}
```

The failed cursor request consumed one discovery attempt; restarting does not reset remaining budget. Invalid cursors use `CURSOR_INVALID` identically. Preserve saved offers and fresh details unless the inherited request is manual refresh. Incomplete old traversal cannot establish coverage; only the replacement traversal can complete it. Explain the restart in the UI even if the replacement later succeeds.

### Manual refresh attached to ordinary work

`createImportRequest(input)` with a new key at `00:00:05Z` while ordinary job-1 is running:

```json
{
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "intent": "manual_refresh"
}
```

202 response:

```json
{
  "id": "request-refresh",
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "intent": "manual_refresh",
  "state": "running",
  "disposition": "attached",
  "jobIds": ["job-1"],
  "pendingFollowUp": true,
  "createdAt": "2026-10-15T00:00:05Z",
  "finishedAt": null,
  "error": null
}
```

Track request time as its refresh cutoff. Successful detail checks performed since it satisfy that offer's recheck; skipped-as-fresh details do not. Repeated refresh clicks while the same area/scope refresh intent is pending attach to that intent and retain the original cutoff; keys prevent transport retries and intent deduplication prevents double-click job duplication. A refresh after terminal completion is a new action.

If ordinary job-1 finishes at `00:00:30Z` after skipping two recent details, `inspectImportRequest("request-refresh")` returns:

```json
{
  "id": "request-refresh",
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "intent": "manual_refresh",
  "state": "queued",
  "disposition": "attached",
  "jobIds": ["job-1", "job-refresh-1"],
  "pendingFollowUp": true,
  "createdAt": "2026-10-15T00:00:05Z",
  "finishedAt": null,
  "error": null
}
```

GET job-refresh-1 is #5's queued snapshot with its own ID, createdAt `00:00:30Z`, the same area/scope and zero job-local counters. It carries the refresh obligation privately; it need not repeat successfully completed discovery. It remains visible in the active queue. Once its two required rechecks succeed, it returns:

```json
{
  "id": "job-refresh-1",
  "state": "succeeded",
  "stage": "finished",
  "createdAt": "2026-10-15T00:00:30Z",
  "startedAt": "2026-10-15T00:00:31Z",
  "finishedAt": "2026-10-15T00:00:36Z",
  "counts": {
    "discovered": 0,
    "checked": 2,
    "added": 0,
    "updated": 1,
    "unchanged": 1,
    "rejected": 0
  },
  "budget": {
    "discoveryUsed": 0,
    "discoveryLimit": 10,
    "detailUsed": 2,
    "detailLimit": 100
  },
  "sources": [
    {
      "sourceId": "fixture",
      "state": "succeeded",
      "coverage": "complete",
      "error": null
    }
  ],
  "coverage": {
    "status": "complete",
    "lastSuccessfulCheckAt": "2026-10-15T00:00:36Z",
    "freshUntil": "2026-10-16T00:00:36Z",
    "scopeKey": "fixture-scope-v1",
    "caveats": ["Configured source coverage only"]
  }
}
```

That coverage is valid only if job-1 completed required discovery and the follow-up cleared all outstanding work. Request-refresh then becomes succeeded, `pendingFollowUp:false`, finishedAt `00:00:36Z`. If bounded follow-up cannot finish, request becomes partial/failed/cancelled truthfully and exposes its terminal job for explicit continuation; it must not stay pending indefinitely or report success. New required discovery can be included in the same bounded follow-up. Added/updated counts displayed per job must not be summed as unique offers across jobs without deduplicating saved identities.

### Cancellation and failures with shared work

`cancelImportRequest("request-refresh")` cancels that intent and its exclusively owned queued follow-ups; shared ordinary job-1 continues for other requests. The request response keeps its IDs/area/intent and sets `state:'cancelled'`, `pendingFollowUp:false`, `finishedAt` to cancellation time, `error:null`. Request cancellation detaches from shared work; cancellation of the last attached active intent requests cooperative job cancellation. A completed cached reference does not own the historical job. A job-level cancel is the explicit queue/execution control and affects attached requests: they report cancellation unless their intent had already completed. Terminal requests do not reopen. No saved records are deleted.

For a running cooperative cancellation, POST job cancel first returns running with cancelRequestedAt set; after an active detail commits, GET returns cancelled/finished with truthful saved counts. Example replacement on #5's base: `{"state":"cancelled","stage":"finished","startedAt":"2026-10-15T00:00:01Z","finishedAt":"2026-10-15T00:00:10Z","cancelRequestedAt":"2026-10-15T00:00:09Z","counts":{"discovered":1,"checked":1,"added":1,"updated":0,"unchanged":0,"rejected":0},"budget":{"discoveryUsed":1,"discoveryLimit":10,"detailUsed":1,"detailLimit":100},"sources":[{"sourceId":"fixture","state":"cancelled","coverage":"partial","error":null}],"coverage":{"status":"partial","lastSuccessfulCheckAt":null,"freshUntil":null,"scopeKey":"fixture-scope-v1","caveats":["Cancelled; saved results retained"]},"reasons":["USER_CANCELLED"],"continuation":{"available":true,"fromJobId":null,"restarted":false,"restartReason":null}}`.

#5's blocked-source response is the failed case with no new progress. If another source succeeds or useful records commit, use partial with per-source errors, reasons and saved counts instead. Saved area results and their actual check times remain readable after either outcome. UI distinguishes an empty successful traversal from failure by job/source outcome, never by listing-array length.
