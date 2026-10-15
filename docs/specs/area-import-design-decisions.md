# Area import design interview

Record of user-confirmed decisions reconciled into specs #1–#4 after final confirmation of the shared understanding.

## Confirmed decisions

- Use local Supabase and Docker, with one documented startup command after prerequisites. The sample-data map is independently releasable before jobs and live integrations.
- One permitted municipal source is sufficient for the first live-source milestone if national-bank access remains unresolved. Explain unsupported geographic areas.
- Represent offers with only municipality-level locations from municipalities intersecting the selected circle with distinct municipality summary pins. Include their counts and listing lists, explicitly saying distance from the selected center is unknown. A representative point may lie outside the circle.
- Prefer a documented municipal representative point, such as its municipal office, rather than a location that appears to identify a house. Use a distinct icon and an exact-location-unknown label. Offers without a known municipality stay in an unknown-location list without a pin.
- Reuse complete results within 24 hours. Provide an explicit manual refresh that bypasses freshness reuse, still reusing active work and obeying all source/request limits.
- Date-based early stopping requires verified source ordering and a checkpoint for the same source and covered area from a completed scan. Consume equal-date records; unsupported ordering falls back to bounded discovery. New discovery and stale known-offer refreshes are separate work.
- Retain configurable defaults of 10 discovery-page requests and 100 detail requests per job, including retries, with one executing import at a time.
- When a request budget is exhausted, preserve partial results and saved progress and offer an explicit search continuation through another bounded job. Do not mark coverage complete or advance the discovery checkpoint prematurely.
- Previously saved listings remain visible during a refresh and after refresh failure, with successful-check timestamps distinguishing old information from refreshed records.
- Cancellation stops scheduling new requests and preserves committed records. An already-running request may settle. Cancelled work resumes only on explicit user action.
- Explicit source withdrawal hides the offer from the default map but retains it locally behind a show-unavailable option. Missing results and failed requests remain insufficient evidence of withdrawal.
- Requests for another area join a visible, cancellable queue. Identical or fully covered requests attach to existing work; partially overlapping jobs reuse completed work when they execute.
- The 24-hour freshness default also applies to known listing details across overlapping searches. Manual refresh rechecks those details within the job budget, showing actual successful-check timestamps.
- Terminal UI outcomes distinguish finished, partial with continuation, cancelled, and failed, with added/updated counts and a reminder that source coverage may be incomplete.
- Show individual pins at source-provided positions even if unverified, labeled accordingly. Approximate positions also carry a distance-uncertainty explanation. Municipality-only offers use summary pins; offers without a usable position or known municipality stay in the unknown-location list. Do not invent house locations or add geocoding in this first version.
- If continuation cursors expire or become invalid, restart discovery safely within request budgets and reuse saved identities/details without claiming incomplete traversal coverage.
- Reserve capacity for stale known-offer refreshes so newly discovered offers cannot consume the entire detail budget. Document a configurable allocation, reuse unused capacity, and carry deferred refresh work forward.
- Manual refresh attaching to ordinary active work retains its stronger refresh intent. Queue missing rechecks, reuse successful checks since the manual request, and do not report completion before required work settles; follow-up work remains bounded, visible, deduplicated, and cancellable.

## Interview status

The user confirmed the shared understanding after all question rounds. The specs incorporate these decisions. Confirmed testing seams remain unchanged: fixture-backed job API tests and the browser journey from selected area to saved map results. The four specs are authoritative for implementation; this file preserves interview context.

## Source-ordering evidence

[LIFULL municipality results](https://www.homes.co.jp/akiyabank/kanagawa/chigasaki/) expose separate new-arrival and update-date sorting. Research did not establish reliable monotonic pagination or complete update-timestamp semantics for either national bank; do not enable early stopping based solely on a sort label.
