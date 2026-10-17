# Desktop runtime

Open Akiya uses Electron, React/TypeScript and embedded SQLite. The renderer is sandboxed and context-isolated. A restricted preload bridge exposes domain operations; the main process validates the sender, main frame and application URL, and the utility-process worker validates operation arguments. Database connections and source observations stay inside the worker.

## Source and build layout

- `src/main/` contains Electron lifecycle code, the utility-process worker, SQLite runtime and synthetic fixtures.
- `src/preload/` contains the isolated API bridge.
- `src/renderer/` contains the React interface, HTML, styles and UI tests.
- `src/shared/` contains process-neutral contracts and geographic validation.

`electron.vite.config.ts` configures bundles, renderer hot reload and Electron rebuilds. `vitest.config.ts` configures unit and DOM tests. Generated bundles go to `out/main`, `out/preload` and `out/renderer`; electron-builder packages `out/`. Development uses the loopback Vite server; production loads local files with a strict content security policy.

## Jobs and local data

The utility process owns the `node:sqlite` connection. SQLite WAL, foreign keys and transactions retain observations, projections and job progress together. Job areas are immutable. Durable request idempotency keys and a transactionally claimed installation-wide executor lease support synthetic imports without duplicate committed offers. Base intent persists its own immutable requested area. Different keys atomically attach to identical or fully covering queued/running jobs when enabled source capabilities, filters and reference semantics match. Partially overlapping circles create separate immutable queued jobs. The attached job retains its covering area, and cancelled jobs accept no new owners. Enabled source capabilities, versions, filters and reference version are frozen in the durable job scope. Lease heartbeats and owner checks prevent another worker from claiming or committing the same live execution.

Closing the window hides the application while imports continue. Launching it again restores the existing window. Explicit Quit stops scheduling and preserves committed progress. Restart recovers interrupted work; cancelled jobs remain cancelled. Work does not execute while the app is fully exited or the computer is asleep.

`src/shared/desktop.ts` defines `createImportRequest`, `inspectImportRequest`, `inspectImport`, `cancelImport`, `cancelImportRequest`, `listImports({state: 'active'})` and `areaResults`. Requests and jobs have separate durable IDs and use the approved #5 DTOs. Both cancellation operations persist intent immediately, stop further source attempts, and preserve committed listings and counters. Running jobs remain running until active work settles; queued jobs cancel before dispatch. Request cancellation immediately detaches only that request and retains its cancellation timestamp. Other owners keep shared execution alive; cancelling the last owner requests cooperative job cancellation. Explicit job cancellation propagates to unfinished attached requests. Terminal requests never reopen. Creation accepts `intent: 'import'`, `intent: 'manual_refresh'` and explicit bounded `intent: 'continue'`. Manual refresh persists its original cutoff separately from shared execution, deduplicates pending intent and rechecks only offers without a successful check since that cutoff. Ordinary settlement atomically links at most one bounded follow-up in the visible queue; exhausted follow-ups require explicit continuation. Request inspection and `pendingFollowUp` govern refresh completion. Cancellation detaches shared work and stops exclusive follow-ups. `src/shared/manual-refresh-fixtures.ts` provides full shared snapshots consumed by UI control tests; the renderer exposes Refresh anyway and tracks request-level follow-up completion. Errors carry a sanitized code, message and retryability. Invalid requests are `INVALID_REQUEST`; unknown IDs are `NOT_FOUND`; conflicting keys are `IDEMPOTENCY_CONFLICT`; disabled sources are `NO_ENABLED_SOURCES`.

The synthetic adapter independently discovers, fetches detail and normalizes one fixed offer at latitude 35, longitude 135. Other areas return a successful empty discovery rather than moving that offer. The worker persists actual discovery/detail request counts before dispatch; observation, approved listing projection, committed counts and candidate progress commit atomically. Repeated unchanged content has an `unchanged` count. Saved-data reads never invoke adapters. Ordinary imports reuse fresh complete successful covering work and independently reuse recent successful listing details. Area results expose persisted coverage evidence and its actual successful-check times; scoped completed discovery checkpoints support safe date stopping as described below.

Area-results queries use the supplied circle independently of import job input. Verified positions use inclusive geodesic membership, including across the antimeridian; source-provided uncertain positions remain unverified. Saved historical positions lacking nonblank verification evidence or a valid verification timestamp are exposed as unverified source points, while new verified observations must provide both. Municipality membership uses the documented synthetic reference geometry, including groups without representative points. Unknown-location candidates require saved intersecting discovery evidence. Availability is filtered before group counts, and reads retain successful source-check timestamps without collecting or claiming complete coverage.

New request/job/lease tables are additive (`*_v2`); existing listing IDs and saved listings remain in place. Legacy foundation job tables remain retained but are not resumed or exposed through the new request contract. This avoids inventing user intents for historical foundation records.

## Remaining requirements

The current app imports fictional sample listings only. The local request/job, refresh and continuation workflows are implemented. Outstanding live-source and distribution work includes:

- Permitted live-source transport and source-specific normalization.
- Live municipality reference geometry and address/place lookup. Synthetic unverified pins, municipality summaries and unknown-location associations are implemented.
- Permitted Tsubata integration, geographic-reference and identity validation, residential eligibility and a bounded live pilot.
- Windows/macOS validation, installer signing/notarization, release icons and published installers.

Worker and React tests use temporary databases and controlled inputs. Automated verification must not make live source requests. Integrated Electron checks require a graphical session and should cover preload isolation, worker IPC, map results, window lifecycle and restart persistence.

## Bounded synthetic execution

The worker-owned `AdapterContext.request` transport validates HTTPS hosts and
redirect destinations, charges every attempt before dispatch, serializes requests,
and persists host pacing deadlines. Default job limits are 10 discovery attempts
and 100 detail attempts across all sources, including retries and redirect hops.
Worker configuration can set positive integer `discoveryLimit`/`detailLimit`;
accepted limits are saved with each job. `minimumIntervalMs` can raise the default
two-second request interval. Synthetic adapters use the same controls and a
no-network success transport; API fixtures inject deterministic response transport,
clock and abort-aware waits. A future live transport must honor its AbortSignal
and return manual redirect responses through this boundary.

Requests time out after 30 seconds by default. Transient transport failures,
timeouts, HTTP 429 and HTTP 5xx receive at most two retries with bounded exponential
backoff. Retry-After seconds and HTTP dates can extend the wait; a requested wait
over one minute terminates that source instead of retrying early. Redirect chains
allow at most five hops. Sanitized outcomes distinguish `TIMEOUT`, `RATE_LIMITED`,
`SOURCE_BLOCKED`, `TRANSPORT_ERROR`, `PARSE_ERROR`, `CONFIGURATION_ERROR`, rejected
source URLs and `BUDGET_EXHAUSTED`. Cancellation interrupts waits and transports.

Source failures do not prevent remaining enabled sources from running. Successful
empty discovery is a success; errors without useful saved work are failures;
useful saved work, saved resumable traversal progress or a mix of successful and failed sources produces partial
results. Rejected details and discovery limitations never certify complete source
coverage. Existing listings and their successful-check times survive failed
checks. Job inspection and area results retain successful covering evidence and
source caveats. Discovery coverage remains complete after independent older-offer refresh failures when traversal completed, while the job stays incomplete and cannot establish reusable cache or promote checkpoints.

Private SQLite source traversal records preserve candidates, cursors, completed
identities, source/version/scope evidence and source outcomes. Retry deadlines and
host pacing survive restart, alongside the existing durable current-job progress.
These records retain date ordering evidence across explicit bounded continuations. Invalid cursors discard abandoned traversal dates before replacement discovery.

Known offers relevant to the selected area enter a separate durable refresh queue,
ordered globally by each source offer's oldest successful check, with unknown
check times first. Worker configuration `refreshReservation` accepts a fraction
from 0 to 1 and defaults to 0.25. When both classes are pending and the detail
budget is at least two, refresh receives at least one attempt and new offers
retain at least one attempt. The refresh phase runs before discovery so an
abundant or failing discovery scan cannot starve older offers. Discovery/new
work runs next; unused new-offer capacity returns to remaining refreshes. The
existing total detail cap includes every retry, redirect hop and conditional
attempt in its originating class. Neither reservation nor release enlarges it.

The queue, completed identities, class attempt counts, configured reservation and
next carried class survive worker restart. A one-attempt job chooses the carried
class and records the opposite class after each attempted request, including
failed attempts. Explicit continuation consumes this durable progress. Manual-refresh known-offer rechecks use this refresh queue. Ordinary imports reuse fresh known-offer details under the policy below.
Deferred refreshes remain private saved work, and budget exhaustion is partial.

## Ordinary-import freshness

Worker options `areaFreshnessMs` and `detailFreshnessMs` each default to 86,400,000
milliseconds (24 hours); zero disables the respective reuse. Exactly at expiry is
stale. Reuse requires one completed successful circle containing the requested
circle by great-circle distance, not overlap or an inferred union. Empty successful
traversals are reusable; unfinished required details, errors and source limitations
cannot establish reusable coverage. Queued requests re-evaluate cache before source
work and persist a cached request referencing the original successful covering job.
Their already-issued queued job remains inspectable as a succeeded zero-work job
with `CACHE_REUSED` and the original coverage evidence.

Source IDs and adapter/query capabilities, `referenceVersion` (default
`synthetic-v1`) and `fixedFilters` (default `{ residential: true }`) form frozen
worker-owned scope semantics. Source fingerprints use canonical ordering; execution
retains the persisted source order across restart. Show unavailable only
filters saved results. Changed semantics invalidate area reuse and relevant detail
reuse; a queued job whose frozen configuration is no longer available fails safely.
No renderer can supply these worker configuration values.

Successful source observations retain a private semantic fingerprint for independent
detail reuse across overlapping searches. Reuse preserves listing check times and
consumes no detail request or checked/updated count. A job's area expiry is capped
by the earliest required detail expiry, so discovery cannot renew skipped details.
Failed attempts never replace successful observation evidence or extend coverage.
Area results retain prior successful coverage after failed refreshes, with persistent
source caveats; coverage always describes configured synthetic discovery, not real
inventory. Historical observations without the fingerprint require a new check.

## Discovery checkpoints

The worker privately stores completed date boundaries by source, exact query scope,
adapter version and date field. The scope includes the selected area, enabled
sources, query/adapter versions, fixed discovery filters and reference version.
Initial and unrelated scopes traverse every page. Date stopping requires declared
verified descending ordering, nonblank evidence and a nonnegative integer overlap
window. The worker validates all dates and descending order on each received page,
including continuity across pages. A missing, invalid or out-of-order date disables
stopping and checkpoint promotion for that traversal. Ordering of unseen pages is
an adapter capability backed by source evidence; the worker cannot prove it from
pages it has not fetched.

A later scan consumes the checkpoint's equal-date ties and inclusive overlap
window before stopping strictly below it. It then checks stale saved offers in the
selected area independently of discovery dates, including offers absent from the
new-offer pages. These detail checks use the existing counted detail budget and
oldest successful-check order. Publication ordering never proves older offers
unchanged. The shared configurable freshness and reserved refresh queue described above
retain old-offer checks independently of discovery stopping.

The final successful job transaction promotes each reliable boundary together with
the terminal job/request result. Partial, failed, cancelled and limited work cannot
promote it, even when discovery itself completed. Failed listing writes and failed
checkpoint writes roll back their transaction. Promotion never moves a boundary
backwards. Renderer responses expose discovery coverage, detail outcomes and real
successful-check times, never checkpoint dates or source cursors. Discovery
coverage does not certify complete real-world inventory, and unfinished details
cannot certify a fresh area cache.

Explicit continuation preserves each source traversal's date evidence and exact
scope, including completed sources and deferred details. Cursor invalidation or
source-limitation restart discards abandoned dates. Only a separately completed
replacement traversal with all required work committed may promote a checkpoint.

## Cursor restart

Continued ordinary imports restart typed `CURSOR_EXPIRED` and `CURSOR_INVALID` discovery within the remaining job budget. The rejected request remains charged, saved offers keep their identities, and fresh details remain reusable. Deferred stale-detail work survives the restart. Changed adapter, filter or geographic reference semantics restart affected saved sources with current fingerprints; an unavailable saved source fails configuration validation. Abandoned date-order evidence cannot establish a checkpoint. Restart flags, reasons and caveats persist through later successful continuation and database reopen. Shared running, exhausted and successful examples are in `src/shared/continuation-fixtures.ts`.

Manual-refresh cursor restart retains the original request cutoff and deferred rechecks across exhausted bounded jobs and database reopen. Explicit continuation reuses successful checks since that cutoff, even when ordinary detail freshness has since expired. Both typed cursor failures have deterministic worker API verification in `src/main/cursor-manual.test.ts`.

## Run the integrated synthetic workflow

Use Node 24 or newer, run `npm ci`, then `npm run dev` in a graphical desktop
session. The application uses the real sandboxed preload bridge, independent
utility-process worker and local SQLite database; no server needs provisioning.
All imported offers are fictional samples around 35, 135. The synthetic adapter
never retrieves bank inventory. Map tiles and explicit place searches normally
use their attributed external providers.

1. Select a circle around 35, 135 (up to 10 km). Pan or zoom freely; only
   **Import sample listings** or **Refresh anyway** requests collection.
2. Import explicitly. Inspect the queue's immutable job area, stages, counters and
   successful-check times. Change the selection or reload while work runs; the
   request and job IDs reconnect to the same worker records.
3. Explore the committed sale pin and companion list, unverified/approximate
   source points, municipality summaries and unknown-location list. The fictional
   municipal office at 35.1, 135 is outside the default circle and represents a
   municipality, never an individual listing. **Show unavailable** filters saved
   records and summary counts without collecting. **Original source** links are
   validated synthetic references at `example.invalid`.
4. Request **Refresh anyway** to bypass cache reuse. Attached work can leave a
   refresh pending until its bounded follow-up completes. Cancel a request to
   withdraw only that intent, or cancel a job to stop its execution. Use
   **Continue search** explicitly when bounded work is incomplete. Saved results
   and actual successful-check times remain available through failure/cancellation.
5. Close the window to hide it while execution continues, then reopen via the
   launcher. Use **Quit Open Akiya** to exit; relaunch recovers committed progress.
   Cancelled work stays cancelled.

Run `npm run test:e2e` for the fixture-backed Electron acceptance journeys. Each
journey uses a disposable profile/database, controlled tile responses and synthetic
source transport. The selected-area journey also uses a loopback place provider.
No live bank requests run. The tests cover selection/import/progress/reconnect,
location categories and unavailable filtering, queue/cancellation, refresh
follow-ups (including withdrawing pending intent), bounded continuation, and
failed refresh retaining saved pins and timestamps in the current selection.
`query-recovery.spec.ts` deliberately controls the query response to exercise UI
failure/focus behavior; it is supplementary and does not establish runtime
integration. Scheduling/budget/race permutations remain at the worker API seam.

Development-only fixture switches require `OPEN_AKIYA_TEST_DATA` (a disposable
profile directory): `OPEN_AKIYA_TEST_IMPORT_PROGRESS=1` slows details;
`OPEN_AKIYA_TEST_IMPORT_QUEUE=1` keeps queue work observable;
`OPEN_AKIYA_TEST_MANUAL_REFRESH=1` disables area cache and delays discovery;
`OPEN_AKIYA_TEST_CONTINUATION=1` limits each job to one detail attempt; and
`OPEN_AKIYA_TEST_SOURCE_FAILURE=1` fails counted synthetic source attempts without
changing saved-data reads. Test runtime configuration is ignored in packaged apps.
These controls exercise the existing worker, not another scheduling implementation.
