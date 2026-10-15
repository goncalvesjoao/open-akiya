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

`src/shared/desktop.ts` defines `createImportRequest`, `inspectImportRequest`, `inspectImport`, `cancelImport`, `listImports({state: 'active'})` and `areaResults`. Requests and jobs have separate durable IDs and use the approved #5 DTOs. Creation accepts only base `intent: 'import'`; active-work attachment, refresh and continuation policies remain outside this slice. Errors carry a sanitized code, message and retryability. Invalid requests are `INVALID_REQUEST`; unknown IDs are `NOT_FOUND`; conflicting keys are `IDEMPOTENCY_CONFLICT`; disabled sources are `NO_ENABLED_SOURCES`.

The synthetic adapter independently discovers, fetches detail and normalizes one fixed offer at latitude 35, longitude 135. Other areas return a successful empty discovery rather than moving that offer. The worker persists actual discovery/detail request counts before dispatch; observation, approved listing projection, committed counts and candidate progress commit atomically. Repeated unchanged content has an `unchanged` count. Saved-data reads never invoke adapters. Rich coverage/freshness reuse and checkpoints remain future work; results conservatively report unknown coverage.

New request/job/lease tables are additive (`*_v2`); existing listing IDs and saved listings remain in place. Legacy foundation job tables remain retained but are not resumed or exposed through the new request contract. This avoids inventing user intents for historical foundation records.

## Remaining requirements

The current app imports fictional sample listings only. The base request/job contracts are implemented; parent #5 has additional child-ticket acceptance work. Outstanding work includes:

- Live source transport, robust field-patch/authoritative-null merging, invalid-observation handling and independent multi-source availability.
- Source request budgets, rate limiting, retries, per-source outcomes, coverage/checkpoints, fair detail refresh allocation and freshness/containment reuse.
- Independent request intent, shared-work cancellation, manual-refresh follow-ups, bounded continuation and expired-cursor recovery.
- Unverified pins, municipality geometry and summaries, unknown-location associations and address/place lookup.
- Permitted Tsubata integration, geographic-reference and identity validation, residential eligibility and a bounded live pilot.
- Windows/macOS validation, installer signing/notarization, release icons and published installers.

Worker and React tests use temporary databases and controlled inputs. Automated verification must not make live source requests. Integrated Electron checks require a graphical session and should cover preload isolation, worker IPC, map results, window lifecycle and restart persistence.
