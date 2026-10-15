# Nightly akiya listing ingestion

Research date: 15 October 2026. This is an implementation proposal; no collection jobs or database changes have been deployed.

## Sources to start with

| Priority | Bank                                       | URL                                                                   | Role                                                                                                        |
| -------- | ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1        | At Home 全国版 空き家・空き地バンク        | https://www.akiya-athome.jp/                                          | National search across participating municipal banks.                                                       |
| 1        | LIFULL HOME’S 空き家バンク                 | https://www.homes.co.jp/akiyabank/                                    | Second national operator; integrate separately and reconcile overlapping properties.                        |
| 2        | Individual municipal and prefectural banks | Discover through the national banks and municipal government websites | Fill measured geographic gaps, prioritizing sources with documented open-data downloads or permitted feeds. |

[MLIT identifies At Home and LIFULL as the two national-bank operators](https://www.mlit.go.jp/totikensangyo/const/sosei_const_tk3_000131.html). These are the best initial candidates for broad coverage, but that does **not** establish that they contain most available akiya in Japan. Vacant homes, homes marketed for sale, and bank registrations are different populations. Measure coverage by municipality; do not advertise completeness.

[MLIT’s integration project explicitly reports duplicates between the two operators](https://www.mlit.go.jp/links/use-cases/4733.html). Adding their listing counts would overstate unique coverage. Both banks also cover vacant land; the initial import should select residential buildings and keep sale and rental offers distinct.

Before enabling each adapter, record its documented access method, terms URL, robots rules, permitted fields, attribution, image rights, rate limit, and review date. Prefer an operator-provided API, partner feed, or licensed export. Public browsing is not permission to bulk collect or republish descriptions and images. An undocumented endpoint used by a website is not a supported integration API. If collection or reuse is prohibited or unclear, leave that source disabled and pursue a permitted feed or municipal open data. No operator outreach is part of this plan’s execution.

Specific access findings:

- [At Home’s terms, articles 4 and 8](https://www.akiya-athome.jp/contents/index/?page=kiyaku) restrict special access beyond ordinary browser use, excessive load, unapproved commercial use, and unauthorized content use.
- [LIFULL HOME’S terms, articles 6 and 16](https://www.homes.co.jp/kiyaku/) restrict unauthorized content reuse and commercial activities. Confirm the proposed collection, storage, and public display rights separately.
- [At Home’s documented municipal API connection](https://www.athome.co.jp/corporate/news/release/services/akiya-bank-202304/) sends municipal data into At Home; it does not establish a nationwide public read API.
- No documented public nationwide read API, bulk export, RSS feed, or open redistribution license was located for either operator in this research. A private partnership option may exist. At Home offers an [official consultation route](https://www.akiya-athome.jp/contents/87); verify LIFULL’s current contact route when pursuing access.

## Recommended architecture

Use **Supabase Cron → durable jobs in Postgres → bounded TypeScript worker batches → Supabase Postgres**. This matches the existing React/TypeScript/Supabase foundation and keeps privileged writes outside the browser.

- A daily SQL job creates one discovery job per enabled source, uniquely keyed by source and Japan calendar date.
- A separate recurring dispatcher invokes an authenticated Edge Function to process a small batch of pending jobs. Work continues after midnight until the queue drains.
- Each adapter implements discovery, detail fetching, and normalization. An approved feed can replace HTML fetching without changing the database contract.
- Discovery creates detail jobs for new or changed offers. Periodic reconciliation checks existing offers for changes and withdrawals.
- A backend-only transactional RPC validates and saves the normalized source observation and public listing projection together.

[Supabase Cron supports database jobs and HTTP invocation](https://supabase.com/docs/guides/cron); its [scheduled-function guide uses pg_net and Vault](https://supabase.com/docs/guides/functions/schedule-functions). Use Vault for invocation secrets and authenticate the worker explicitly; possession of the public project key must not authorize imports.

Use a private job table for the first version, claimed transactionally with `FOR UPDATE SKIP LOCKED`, a lease expiry, attempt count, and retry time. [Supabase Queues](https://supabase.com/docs/guides/queues) is an alternative if we prefer its queue management. In either case, design for repeated delivery and idempotent writes.

Avoid a single function that crawls the entire country. [Hosted Edge Functions have bounded wall time, memory, and CPU](https://supabase.com/docs/guides/functions/limits). Stop batches well before the configured limits and persist progress. If an authorized integration needs browser rendering or substantial CPU, use a containerized TypeScript consumer against the same jobs instead; benchmark one adapter before selecting that runtime.

## Midnight schedule

Assume midnight means **00:00 Asia/Tokyo**, based on this project’s Japanese scope. Store timestamps as UTC `timestamptz` and derive the run’s date explicitly in Asia/Tokyo.

With a UTC scheduler, `0 15 * * *` starts the run at midnight JST the following calendar day. Confirm the deployed scheduler timezone before enabling it; [pg_cron’s timezone is configurable](https://github.com/citusdata/pg_cron). Midnight is the start time, not a guarantee that all listings finish importing at that instant.

Add a catch-up check that creates any missing daily run after an outage. A unique `(source_id, scheduled_date_jst)` constraint prevents duplicate runs. A source-level lease prevents overlapping discovery scans, including manual retries.

## Uniform database structure

The existing migration provides Japanese and English text, one source URL, prefecture, municipality, a single yen price, coordinates, publication status, and timestamps. Keep those public-facing fields, but extend the model through new migrations rather than rewriting the initial migration.

| Table                          | Proposed responsibilities and important fields                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestion_sources` (private)  | Stable key, base URL, adapter version, enabled flag, access/rights record, rate policy, discovery cursor, last successful run.                                                                                                                                  |
| `ingestion_runs` (private)     | Source, JST scheduled date, start/end, state, discovery completeness, discovered/new/changed/unchanged/rejected counts, error summary.                                                                                                                          |
| `ingestion_jobs` (private)     | Run/source, job kind, source record ID or cursor, unique job key, state, lease, attempts, next attempt, redacted error.                                                                                                                                         |
| `source_listings` (private)    | Unique `(source_id, external_id)`, canonical source URL, optional municipal reference, linked public listing ID, normalized payload, content hash, parser version, first/last seen, last successful check, source update time, availability, missed-scan count. |
| `listings` (public projection) | Existing fields plus transaction type, separate sale price and monthly rent, property type, land/building area in m², layout, optional build year, address precision, coordinate provenance, availability, first/last seen. Retain primary source attribution.  |

The private source table preserves multiple source identities for one public property; the current unique `listings.source_url` can remain the primary attribution URL, not the cross-bank identity. Different sale/rental offers must not overwrite each other. Initially create separate public records unless a shared municipal reference proves they are the same property and offer. Queue uncertain matches for review; a similar title, approximate map point, or municipality alone is insufficient to merge.

Keep `status = draft | published | archived` for editorial visibility. Add independent `availability = available | under_offer | unavailable | unknown` so collection does not overwrite moderation decisions. Make `source_checked_at` mean a successful source check; failed fetches belong in run/job diagnostics.

Normalization contract:

- Preserve Japanese originals; English translations remain optional and run separately after ingestion.
- Use integer yen for money, decimal square metres for areas, and explicit sale/rent/both/unknown transaction types. Define `price_jpy` as sale price and introduce `rent_monthly_jpy` for rent; use a documented compatibility migration before exposing rentals.
- Convert `万円` to yen and `坪` to m² deterministically. Unknown/negotiable prices are null with an explanatory price note; zero means explicitly free. Preserve source text for ambiguous values.
- Normalize prefectures and municipality codes using a versioned official reference dataset selected during implementation; keep address text as published. Do not infer a street address from a municipality name.
- Store both coordinates or neither; record whether a point is source-provided, geocoded, or approximate. Keep an approximate location visibly approximate.
- Missing fields in a partial response must not erase known fields. Distinguish absent fields from explicit source removals, and validate a complete normalized snapshot before replacement.
- Store only permitted source evidence, with a retention policy. Keep raw payloads private if allowed; do not retain full pages, contact details, photos, or copyrighted descriptions by default. Record field-level provenance where sources disagree.

Revoke browser access to operational tables and source payloads, enable RLS, and expose only approved published fields. Backend credentials belong in worker secrets, never `VITE_` variables. Escape source text on display and allowlist source hosts and redirects before fetching URLs.

## What happens each night

1. **Discover:** enumerate all permitted feed/search pages, partitioning by municipality or prefecture when necessary. Save pagination progress and record whether the scan completed. On first activation, perform a resumable baseline import.
2. **Detect changes:** use stable source IDs; fall back to a canonical URL only where necessary. Use supported update timestamps or conditional requests when available. Otherwise compare hashes of normalized business fields. If discovery pages do not expose changes, schedule detail rechecks in rotating batches with a configurable maximum age; do not claim immediate update detection.
3. **Fetch politely:** apply the operator’s limits. In the absence of an agreed limit, propose one request at a time with a two-second minimum gap, subject to permission review. Honor `Retry-After`, use bounded exponential backoff with jitter, and stop on access blocks rather than trying to bypass them.
4. **Normalize and validate:** quarantine unrecognized units, missing required fields, unexpected templates, or malformed prices. One bad record must not abort the source run or damage the last valid listing.
5. **Upsert atomically:** enforce source identity uniqueness in Postgres. Save a changed observation and rebuild the public projection according to provenance rules. Acknowledge the job only after commit; a retry after a crash must produce the same result. Do not include fetch timestamps in the content hash.
6. **Reconcile availability:** explicit withdrawal is evidence of unavailability. A timeout, blocked page, partial scan, or parser failure is not. Increment absence counters only after a verified complete scan; after three consecutive complete absences, recheck the detail page and flag stale/unknown for review. Never bulk archive on a sudden count drop. A property remains available if another current source still lists it.
7. **Finish and monitor:** mark a run complete only when required jobs finish; otherwise mark partial/failed. Advance high-water marks only after successful processing. Alert on failures, stale sources over 26 hours, abnormal count changes, growing retries, or unusually high validation failures.

Use a small overlap window for timestamp-based discovery and a weekly complete reconciliation when permitted. Without reliable timestamps, enumerate stable IDs nightly and refresh details on a bounded schedule. The worker searches the banks directly; it does not depend on daily search-engine indexing.

## Implementation sequence and completion criteria

1. **Access and sample investigation:** resolve access/reuse for one source; inspect representative sale, rental, free, negotiable-price, unavailable, and paginated records. Confirm stable IDs, update signals, pagination limits, and runtime needs. Keep disabled sources documented.
2. **Database and contracts:** add private operational tables, source identity constraints, public-field migrations, RLS, typed normalization rules, and transactional upsert. Backfill any existing listings without losing URLs or IDs.
3. **First adapter:** implement approved discovery/detail access, fixture-based parsers, dry-run reports, retries, leases, and a manual bounded import. New records start as drafts until sample review passes.
4. **Scheduling and operations:** deploy the midnight scheduler and batch dispatcher, configure secrets, catch-up runs, metrics, retention, and a per-source kill switch. Validate the actual JST firing time and restart recovery.
5. **Second bank and coverage:** add the second adapter, reconcile proven duplicates, and report unique offers and coverage by municipality. Add direct municipal adapters only where gaps justify maintenance.

Acceptance checks should prove that repeated runs and retries create no duplicate source offers; sale/rent and unknown/free prices stay distinct; changed prices update correctly; partial scans never withdraw properties; cross-bank duplicates retain attribution; moderation survives refreshes; private data is unreadable from browser credentials; and crash recovery resumes unfinished jobs. Benchmark a pilot to estimate requests, runtime, storage, and cost before a nationwide baseline. Exact effort and operating cost depend on access agreements and source structure, which remain discovery tasks.
