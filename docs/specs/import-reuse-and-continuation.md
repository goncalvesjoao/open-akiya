# Import cache reuse, refresh scheduling, and bounded continuation

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

- Retain the user-confirmed job API seam with test Postgres and deterministic fixture adapters, plus the existing map browser journey where UI behavior is involved. Assert observable behavior, not implementation internals.
- Verify area containment versus mere overlap, source/filter/version invalidation, cache re-evaluation when queued work begins, and reuse of individual listing details within 24 hours.
- Verify reserved refresh capacity, oldest-first deferred work, release of unused capacity, retry accounting, and total discovery/detail caps with mixed new and stale offers.
- Verify initial scans and unrelated scopes cannot reuse checkpoints; consume equal-date ties; disable early stopping for unreliable dates; preserve older-offer refreshes; never advance checkpoints after partial, cancelled, or failed traversals.
- Verify Continue search retains progress across bounded jobs, invalid cursors trigger safe bounded restarts without duplicate records or false coverage, and manual refresh attached to ordinary work queues missing rechecks without premature success.
- The repository currently has no job test precedent. Introduce only necessary tooling and use controlled clocks/network responses; automated checks make no live bank requests.

## Out of Scope

Map UI integration and live source retrieval are separate milestones. Reuse the existing API and fixture-adapter seams rather than introducing a parallel worker.

- Hosted deployment, nightly or nationwide collection, paid discovery, translation, image mirroring, and fuzzy cross-source merging remain excluded.

## Further Notes

- Parent #3 retains the complete acceptance contract. This child owns the implementation decisions allocated here; completing it alone does not close #3. Existing map and live-source requirements remain in their respective specs.
