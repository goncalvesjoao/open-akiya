# Prompts for planning implementation sessions

Open each session in the `open-akiya` repository. Copy one complete prompt below. These prompts prepare implementation tickets; they do not authorize implementing every ticket, merging changes, or deploying the app.

Start with contract alignment, then ticket #2 and #5. Source investigation can run alongside that work. Ticket #6 and #7 once the job contracts settle; their development can overlap. Ticket the live adapter after investigation establishes a feasible source. Consult the [implementation plan](implementation-plan.md) for start conditions and completion gates.

Use the same checkout sequentially for planning edits. If running sessions concurrently, give each its own branch/worktree and make agreed contract changes available to the other sessions before they depend on them. Local documentation is currently uncommitted; a fresh clone or worktree may not contain it. Make the planning documents available before starting, and have the session report missing context rather than inventing it.

## 1. Align shared contracts

```text
In goncalvesjoao/open-akiya, read AGENTS.md, GLOSSARY.md, relevant ADRs, docs/implementation-plan.md, and GitHub specs #1–#7, including comments. Inspect the current code and any existing contract definitions.

Prepare the shared contracts needed for parallel map and backend work: selected area, listing projection and location uncertainty, job API, policy extensions, and source adapter. Record concrete request/response examples in the owning specs, including queued/running, empty success, partial continuation, expired-cursor restart, manual-refresh follow-up, cancelled, and failed cases. Reuse existing definitions rather than creating competing contracts.

Preserve the agreed scope and testing seams. Surface any unresolved product decisions for me; resolve routine technical choices with a recommendation. Do not implement the feature or create another spec/ticket merely for contract alignment. Synchronize approved contract documentation with its existing GitHub spec and report what is ready for parallel work.
```

## 2. Ticket the map spec

```text
$ticket-it https://github.com/goncalvesjoao/open-akiya/issues/2

Read AGENTS.md, GLOSSARY.md, relevant ADRs, docs/implementation-plan.md, and the agreed area/listing contracts. Inspect the current code and the parent's comments and existing sub-issues before proposing work.

Break only #2 into independently demoable vertical slices sized for a fresh implementation session. Use synthetic listings; retain unverified individual pins, municipality summary pins, unknown-location lists, and Show unavailable. Reuse the confirmed browser-level testing approach.

Show the proposed tickets and genuine start blockers for approval before publishing. Each ticket must be a direct sub-issue of #2. Do not create duplicate tickets under aggregate parents #1 or #3, require a finished backend for the sample map, or start implementation.
```

## 3. Ticket the runtime/storage spec

```text
$ticket-it https://github.com/goncalvesjoao/open-akiya/issues/5

Read AGENTS.md, GLOSSARY.md, relevant ADRs, docs/implementation-plan.md, the agreed area/listing/job/adapter contracts, and specs #2, #3, and #5 with their comments and existing tickets. Inspect the current code.

Break only #5 into independently verifiable vertical slices through the local job API, synthetic adapter, persistent worker, and normalized storage. Include privacy, idempotency, cancellation, and restart recovery. Reuse the confirmed job-API testing seam with test Postgres and deterministic fixtures. Coordinate shared contracts with #2 without requiring its finished map.

Show the proposed tickets and genuine start blockers for approval before publishing. Each ticket must be a direct sub-issue of #5. Keep #6 policy work and #7 browser integration outside this breakdown. Do not start implementation or duplicate aggregate-parent tasks.
```

## 4. Investigate a live source in parallel

```text
In goncalvesjoao/open-akiya, read AGENTS.md, GLOSSARY.md, docs/implementation-plan.md, and spec https://github.com/goncalvesjoao/open-akiya/issues/4 with its comments and source research. Investigate one feasible permitted live source using primary sources, while map/backend work proceeds independently.

Establish access and reuse conditions, geographic filtering, stable identities, available fields, pagination/cursor validity, date semantics, location precision, and rate constraints. A permitted municipal feed is acceptable if national-bank access remains unresolved. Distinguish verified capabilities from assumptions, especially newest-first ordering and safe early stopping.

Save cited findings in the repository and identify a concrete candidate for the first adapter, or explain the remaining blocker. No paid discovery services, bulk collection, access-block circumvention, or messages to source operators. Do not claim the live-source spec complete or create implementation tickets until findings are sufficient.
```

## 5. Ticket reuse, refresh, and continuation

```text
$ticket-it https://github.com/goncalvesjoao/open-akiya/issues/6

Read AGENTS.md, GLOSSARY.md, docs/implementation-plan.md, specs #3, #5, and #6, their comments/tickets, and the current job/adapter contracts and code. Confirm the contracts are stable enough to plan against; distinguish available runtime behavior from unfinished dependencies.

Break only #6 into verifiable vertical slices using the established job API seam. Cover cache containment and freshness, work attachment, manual-refresh intent and follow-ups, fair request budgets, safe checkpoints, bounded continuation, and expired-cursor recovery. Preserve refresh capacity for older offers and avoid premature completion claims.

Show the proposed tickets and genuine start blockers for approval before publishing. Each ticket must be a direct sub-issue of #6. Identify which slices can start against agreed contracts while #5 finishes. Coordinate API fixtures with #7; do not turn spec-level completion gates into unnecessary ticket start blockers or begin implementation.
```

## 6. Ticket the map import UI

```text
$ticket-it https://github.com/goncalvesjoao/open-akiya/issues/7

Read AGENTS.md, GLOSSARY.md, docs/implementation-plan.md, specs #2, #3, #5, #6, and #7, their comments/tickets, and the agreed job/policy API examples. Inspect the actual map and backend code before planning.

Break only #7 into demoable user-facing slices. Mock-backed UI work may proceed while runtime/policies finish, but final acceptance requires the real local runtime and the confirmed fixture-backed browser journey. Include explicit import/refresh/continue/cancel controls, visible queue and follow-ups, reload recovery, saved results during failure, truthful terminal messages, and map/list refresh.

Show the proposed tickets and genuine start blockers for approval before publishing. Each ticket must be a direct sub-issue of #7. Separate mock-backed start conditions from real integration blockers, referencing existing prerequisite tickets where appropriate. Do not duplicate backend policies in the browser, close #3 prematurely, or begin implementation.
```

## 7. Ticket the investigated live adapter

```text
$ticket-it https://github.com/goncalvesjoao/open-akiya/issues/4

Read AGENTS.md, GLOSSARY.md, docs/implementation-plan.md, the latest cited source investigation, spec #4 with comments/sub-issues, and the current adapter/job contracts and implementation. Verify that one concrete source has a feasible permitted access method. If not, report that blocker instead of inventing an enabled integration.

Break only #4 into verifiable slices for that source: geographic discovery, detail normalization and persistence, source-specific failure/continuation behavior, and the small documented live pilot. Reuse fixture-backed job API tests; routine checks must not scrape live sources. Only enable early stopping if source guarantees support it. No paid discovery services.

Show the proposed tickets and genuine start blockers for approval before publishing. Each ticket must be a direct sub-issue of #4. Allow source-shaped fixture development once contracts are ready; gate the live pilot on the completed integrated worker flow and resolved access. Do not ticket aggregate parents #1/#3, send messages to operators, or start implementation.
```

## Choosing implementation work afterward

After each approved breakdown is published, use its ticket URLs to choose implementation work. Start only tickets whose actual start blockers are satisfied. A ticket's completion does not automatically close its spec or either aggregate parent; use the integration checkpoints in the execution plan.
