# Desktop runtime

Open Akiya uses Electron, React/TypeScript and embedded SQLite. The renderer is sandboxed and context-isolated. A restricted preload bridge exposes domain operations; the main process validates the sender, main frame and application URL, and the utility-process worker validates operation arguments. Database connections and source observations stay inside the worker.

## Source and build layout

- `src/main/` contains Electron lifecycle code, the utility-process worker, SQLite runtime and synthetic fixtures.
- `src/preload/` contains the isolated API bridge.
- `src/renderer/` contains the React interface, HTML, styles and UI tests.
- `src/shared/` contains process-neutral contracts and geographic validation.

`electron.vite.config.ts` configures bundles, renderer hot reload and Electron rebuilds. `vitest.config.ts` configures unit and DOM tests. Generated bundles go to `out/main`, `out/preload` and `out/renderer`; electron-builder packages `out/`. Development uses the loopback Vite server; production loads local files with a strict content security policy.

## Jobs and local data

The utility process owns the `node:sqlite` connection. SQLite WAL, foreign keys and transactions retain observations, projections and job progress together. Job areas are immutable. Durable idempotency keys, exact-area active-job reuse, a serial cancellable queue and successful-check timestamps support synthetic imports without duplicate committed offers.

Closing the window hides the application while imports continue. Launching it again restores the existing window. Explicit Quit stops scheduling and preserves committed progress. Restart recovers interrupted work; cancelled jobs remain cancelled. Work does not execute while the app is fully exited or the computer is asleep.

`src/shared/desktop.ts` defines `createImport`, `inspectImport`, `cancelImport`, `listImports` and `areaResults`. These return basic jobs or saved results. Cancelling an attached basic job cancels shared execution; independent request ownership is not implemented. The current `updated` count includes existing fixture identities saved again, including unchanged business values.

## Remaining requirements

The current app imports fictional sample listings only. The richer request/job contracts in the specifications remain acceptance targets. Outstanding work includes:

- Source transport, field-patch normalization, content hashes, changed/unchanged/rejected counts and independent multi-source availability.
- Source request budgets, rate limiting, retries, per-source outcomes, coverage/checkpoints, fair detail refresh allocation and freshness/containment reuse.
- Independent request intent, shared-work cancellation, manual-refresh follow-ups, bounded continuation and expired-cursor recovery.
- Unverified pins, municipality geometry and summaries, unknown-location associations and address/place lookup.
- Permitted Tsubata integration, geographic-reference and identity validation, residential eligibility and a bounded live pilot.
- Windows/macOS validation, installer signing/notarization, release icons and published installers.

Worker and React tests use temporary databases and controlled inputs. Automated verification must not make live source requests. Integrated Electron checks require a graphical session and should cover preload isolation, worker IPC, map results, window lifecycle and restart persistence.
