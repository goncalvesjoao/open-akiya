# Map import controls, queue, progress, and result refresh

Part of #3, under #1. Can start against mocked responses once map/job contracts settle; integrated completion is blocked by #2 and #6. Completing all #3 children satisfies #3 only after the full fixture-backed browser journey passes. See the [implementation plan](../implementation-plan.md).

## Problem Statement

A working local worker is insufficient if users cannot start it from the selected area, understand queued or partial work, or discover saved results without restarting the page.

## Solution

Connect the existing map to the completed job API, exposing explicit import, manual refresh, continuation, cancellation, queue visibility, and reconnectable progress. Keep saved results visible and refresh them on terminal outcomes.

## User Stories

1. As a user, I want cached listings shown before collection, so that existing information is immediately useful.
2. As a user, I want freshness and coverage information, so that I can judge whether to request an update.
3. As a user, I want an explicit import button for my selected area, so that map movement does not collect information.
4. As a user, I want immediate acknowledgement, so that I know the request was accepted.
5. As a user, I want discovery, fetching, and saving progress, so that I understand ongoing work.
6. As a user, I want to keep using the map while the worker runs, so that the UI remains responsive.
7. As a user, I want the job's original area displayed after changing my selection, so that scope stays clear.
8. As a user, I want repeated requests to reuse work, so that double clicks do not duplicate collection.
9. As a user, I want cancellation, so that unnecessary requests stop.
10. As a user, I want progress restored after reload, so that I do not restart the job accidentally.
11. As a user, I want interrupted work to recover after restart, so that committed results are preserved.
12. As a user, I want the map and list refreshed when work ends, so that results become discoverable.
13. As a user, I want outcome counts, so that I know what was added or updated.
14. As a user, I want partial, failed, cancelled, and empty outcomes distinguished, so that coverage is not overstated.
15. As a user, I want Refresh anyway to recheck recent results within traffic limits, so that I can explicitly request fresher information.
16. As a user, I want Continue search to resume a budget-limited search, so that I can retrieve more results without restarting completed work.
17. As a user, I want another area's request to enter a visible cancellable queue, so that I can plan searches without running workers concurrently.
18. As a user, I want saved listings visible during failed refreshes, so that temporary failures do not erase useful results.

## Implementation Decisions

- Keep previously saved listings visible during work and after failures, with actual successful-check timestamps. Refresh the map/list query on every terminal outcome, preserving committed partial results and selection. Follow the map contract for verified pins, unverified individual pins, municipality summary pins, and unknown-location candidates.
- Terminal messages distinguish Search finished, Partial results—continue search, Cancelled, and Failed. Explain added/updated counts, freshness, truncation, and source failures, with a persistent reminder that source coverage may be incomplete. A finished traversal is not a claim of exhaustive available homes.
- Provide explicit controls for import, Refresh anyway, Continue search, and cancel; show queued work, immutable job areas, real counts/stages, and pending manual-refresh follow-ups. Persist reconnectable request/job identifiers across reloads. Maintain keyboard and mobile usability.

## Testing Decisions

- Retain the user-confirmed job API seam with test Postgres and deterministic fixture adapters, plus the existing map browser journey where UI behavior is involved. Assert observable behavior, not implementation internals.
- Extend the confirmed browser journey: select an area, start a fixture-backed import, observe progress, reload/reconnect, then see committed listings on the map and list.
- Verify map movement alone never starts collection, a changed selection does not mutate a running job area, the queue is visible/cancellable, and manual-refresh follow-ups remain pending and cancellable.
- Verify partial outcomes expose Continue search and restart explanations; saved results and timestamps remain visible after failure; terminal messages distinguish empty success, truncation, cancellation, and failure.
- Verify verified/unverified individual pins, municipality summary counts and lists, unknown-location offers, and Show unavailable use the established map contract after imports.
- The repository currently has no job test precedent. Introduce only necessary tooling and use controlled clocks/network responses; automated checks make no live bank requests.

## Out of Scope

Database design, worker scheduling policies, source access, and live adapters are owned by prerequisite specs. Use their API contracts and do not reimplement job logic in the browser.

- Hosted deployment, nightly or nationwide collection, paid discovery, translation, image mirroring, and fuzzy cross-source merging remain excluded.

## Further Notes

- Parent #3 retains the complete acceptance contract. This child owns the implementation decisions allocated here; completing it alone does not close #3. Existing map and live-source requirements remain in their respective specs.
