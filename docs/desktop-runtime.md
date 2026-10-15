# Desktop runtime

Open Akiya uses Electron, React/TypeScript and embedded SQLite. The renderer is sandboxed and context-isolated. A restricted preload bridge exposes domain operations; the main process validates the sender, main frame and application URL, and the utility-process worker validates operation arguments. Database connections and source observations stay inside the worker.

## Source and build layout

- `src/main/` contains Electron lifecycle code, the utility-process worker, SQLite runtime and synthetic fixtures.
- `src/preload/` contains the isolated API bridge.
- `src/renderer/` contains the React interface, HTML, styles and UI tests.
- `src/shared/` contains process-neutral contracts and geographic validation.

`electron.vite.config.ts` configures bundles, renderer hot reload and Electron rebuilds. `vitest.config.ts` configures unit and DOM tests. Generated bundles go to `out/main`, `out/preload` and `out/renderer`; electron-builder packages `out/`. Development uses the loopback Vite server; production loads local files with a strict content security policy.

## Jobs and local data

The utility process owns the `node:sqlite` connection. SQLite WAL, foreign keys and transactions retain observations, projections and job progress together. Job areas are immutable. Durable request idempotency keys and a transactionally claimed installation-wide executor lease support synthetic imports without duplicate committed offers. Base intent creates one request and one job; different keys never attach to active jobs. Enabled source capabilities, versions, filters and reference version are frozen in the durable job scope. Lease heartbeats and owner checks prevent another worker from claiming or committing the same live execution.

Closing the window hides the application while imports continue. Launching it again restores the existing window. Explicit Quit stops scheduling and preserves committed progress. Restart recovers interrupted work; cancelled jobs remain cancelled. Work does not execute while the app is fully exited or the computer is asleep.

`src/shared/desktop.ts` defines `createImportRequest`, `inspectImportRequest`, `inspectImport`, `cancelImport`, `cancelImportRequest`, `listImports({state: 'active'})` and `areaResults`. Requests and jobs have separate durable IDs and use the approved #5 DTOs. Both cancellation operations persist intent immediately, stop further source attempts, and preserve committed listings and counters. Running jobs remain running until active work settles; queued jobs cancel before dispatch. Cancellation is idempotent, leaves completed outcomes intact, and propagates to the sole base request. Creation accepts only base `intent: 'import'`; active-work attachment, refresh and continuation policies remain outside this slice. Errors carry a sanitized code, message and retryability. Invalid requests are `INVALID_REQUEST`; unknown IDs are `NOT_FOUND`; conflicting keys are `IDEMPOTENCY_CONFLICT`; disabled sources are `NO_ENABLED_SOURCES`.

The synthetic adapter independently discovers, fetches detail and normalizes one fixed offer at latitude 35, longitude 135. Other areas return a successful empty discovery rather than moving that offer. The worker persists actual discovery/detail request counts before dispatch; observation, approved listing projection, committed counts and candidate progress commit atomically. Repeated unchanged content has an `unchanged` count. Saved-data reads never invoke adapters. Saved area results conservatively report unknown coverage; job responses distinguish discovery traversal from required detail work. The scoped checkpoint behavior below applies to adapters with verified date ordering.

Area-results queries use the supplied circle independently of import job input. Verified positions use inclusive geodesic membership, including across the antimeridian; source-provided uncertain positions remain unverified. Saved historical positions lacking nonblank verification evidence or a valid verification timestamp are exposed as unverified source points, while new verified observations must provide both. Municipality membership uses the documented synthetic reference geometry, including groups without representative points. Unknown-location candidates require saved intersecting discovery evidence. Availability is filtered before group counts, and reads retain successful source-check timestamps without collecting or claiming complete coverage.

New request/job/lease tables are additive (`*_v2`); existing listing IDs and saved listings remain in place. Legacy foundation job tables remain retained but are not resumed or exposed through the new request contract. This avoids inventing user intents for historical foundation records.

## Remaining requirements

The current app imports fictional sample listings only. The base request/job contracts are implemented; parent #5 has additional child-ticket acceptance work. Outstanding work includes:

- Live source transport, robust field-patch/authoritative-null merging, invalid-observation handling and independent multi-source availability.
- Cross-job checkpoint verification, fair detail refresh allocation and freshness/containment reuse.
- Independent request intent, shared-work cancellation, manual-refresh follow-ups, bounded continuation and expired-cursor recovery.
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
results. Rejected discovery candidates and source limitations never certify complete
discovery coverage. A completed traversal can retain complete discovery coverage
while required older-offer detail refresh fails, leaving the job partial. Existing listings and their successful-check times survive failed
checks. Job inspection reports these outcomes while area results retain
conservative unknown coverage.

Private SQLite source traversal records preserve candidates, cursors, completed
identities, source/version/scope evidence and source outcomes. Retry deadlines and
host pacing survive restart, alongside the existing durable current-job progress.
The checkpoint policy retains date evidence with these records for later explicit
continuations. Bounded continuation and cursor restart remain owned by #23.

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
unchanged. The current 24-hour stale check is the default contract; configurable
freshness, fair reservation and durable cross-job refresh scheduling remain #22.

The final successful job transaction promotes each reliable boundary together with
the terminal job/request result. Partial, failed, cancelled and limited work cannot
promote it, even when discovery itself completed. Failed listing writes and failed
checkpoint writes roll back their transaction. Promotion never moves a boundary
backwards. Renderer responses expose discovery coverage, detail outcomes and real
successful-check times, never checkpoint dates or source cursors. Discovery
coverage does not certify complete real-world inventory, and unfinished details
cannot certify a fresh area cache.

Cross-job completion verification remains blocked on #23. Its continuation must
retain the source traversal's date evidence and exact scope, abandon that evidence
on cursor invalidation, and promote only after all inherited required work commits.
The current implementation makes no cross-job completion claim.
