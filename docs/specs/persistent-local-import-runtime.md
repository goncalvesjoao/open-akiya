# Persistent local import runtime and normalized listing storage

Part of #3, under #1. Can start alongside #2 after area/listing contract alignment; no finished-map dependency. See the [implementation plan](../implementation-plan.md) for parallel start conditions and integration gates.

## Problem Statement

Users cannot run a persistent area import or safely retain results locally. Browser navigation, retries, and restarts must not lose or duplicate committed offers.

## Solution

Provide a local job API and worker that imports synthetic offers into local Supabase, reports durable job state, and supports cancellation and restart recovery. This is an independently verifiable API milestone before cache policies and UI integration.

## User Stories

1. As a local user, I want documented frontend, backend, and database startup, so that I can run the tool locally.
2. As a user, I want immediate acknowledgement, so that I know the request was accepted.
3. As a user, I want discovery, fetching, and saving progress, so that I understand ongoing work.
4. As a user, I want cancellation, so that unnecessary requests stop.
5. As a user, I want interrupted work to recover after restart, so that committed results are preserved.
6. As a user, I want outcome counts, so that I know what was added or updated.
7. As a user, I want partial, failed, cancelled, and empty outcomes distinguished, so that coverage is not overstated.
8. As a user, I want my imported records retained locally, so that there is no central dataset upload.
9. As a maintainer, I want deterministic end-to-end fixtures, so that I can verify the workflow without live-source access.
10. As a user, I want credentials and raw errors kept out of browser responses, so that local backend privileges remain protected.

## Implementation Decisions

- Use local Supabase Postgres and a local TypeScript backend/worker, independent of browser lifetime. Document Docker/Supabase prerequisites and one startup command after prerequisites are installed. Keep privileged credentials server-side, bind to loopback, validate mutation requests, and restrict origins.
- Add create, inspect, cancel, and area-results API operations. Create validates center coordinates and radius greater than zero and at most 10 km on the server, accepts an idempotency key, and immediately returns a persisted job ID or explicit cache/in-flight reuse outcome. Job input is immutable after creation.
- Inspection exposes state, stage, timestamps, original area, meaningful counters, per-source outcomes, budget usage, and sanitized errors. States are queued, running, succeeded, partial, failed, and cancelled. Report counts rather than fabricated percentages. Persist enough UI context to reconnect to the job after reload; polling is sufficient.
- Persist jobs, source tasks, checkpoints, coverage records, retry times, and leases. Claim jobs transactionally; reclaim expired leases on restart. Enforce one executing import per installation initially. Cancellation stops scheduling outbound work and preserves completed transactions; inspect and cancel are idempotent.
- Define adapter discovery/detail/normalization contracts and implement a synthetic adapter that can deterministically simulate pagination, changes, delays, failures, and cancellation. Label fixture mode clearly. The next spec supplies the first live implementation.
- Extend the existing listing schema with provider-scoped stable source identities and observations, transaction type, separate integer sale yen and monthly rent yen, optional decimal areas, availability separate from editorial publication state, location precision/provenance, content hashes, and successful-check timestamps. Preserve current listing IDs, Japanese originals, primary attribution, and visibility decisions through additive migrations.
- Save validated source observations and listing projections atomically. A retry after commit cannot duplicate offers. Missing money remains null; free is explicit zero. Partial payloads cannot clear known valid fields. Distinct sale/rental offers remain distinct. Only proven cross-source matches may share a property projection.
- Operational tables and raw observations are private with RLS and restricted grants. Browsers receive approved listing projections through the local API. Imported records may appear locally without making them publicly published or changing editorial status.
- Hide explicitly unavailable offers from default results while retaining local history and Show unavailable. Preserve independent source observations so another current source can still support availability. Failed checks and scoped absence cannot hide a listing as withdrawn.
- A scoped or failed job cannot establish global absence. Never withdraw listings solely because a request omits them. Show a configuration error rather than successful empty results when no source is enabled.
- The base API exposes durable queued/running/terminal states, bounded execution, and a replaceable adapter boundary. Policy-sensitive manual refresh and continuation operations are completed by the next child; document the API contract so that extension does not require another runtime.

## Testing Decisions

- Retain the user-confirmed job API seam with test Postgres and deterministic fixture adapters, plus the existing map browser journey where UI behavior is involved. Assert observable behavior, not implementation internals.
- Reject invalid areas without outbound requests; repeated idempotency keys reuse the same job; prove one executor, queued cancellation, lease expiry, recovery after commit, and that cancellation never automatically resumes.
- Verify normalized money, distinct offers, source uniqueness, private operational records, permitted local projections, explicit unavailable visibility, and preservation of moderation and valid data after malformed input.
- The repository currently has no job test precedent. Introduce only necessary tooling and use controlled clocks/network responses; automated checks make no live bank requests.

## Out of Scope

Cache reuse, conditional early stopping, continuation policies, manual-refresh follow-ups, and browser integration belong to the next two child specs. This milestone does not claim full parent completion.

- Hosted deployment, nightly or nationwide collection, paid discovery, translation, image mirroring, and fuzzy cross-source merging remain excluded.

## Further Notes

- Parent #3 retains the complete acceptance contract. This child owns the implementation decisions allocated here; completing it alone does not close #3. Existing map and live-source requirements remain in their respective specs.

## Shared contracts: listing projection and area results

Contract alignment, 2026-10-15. Reuse `Point`, `SelectedArea`, and `AreaQuery` from #2. The definitions below are the sole listing/job/adapter contract for #2, #4, #6, and #7. TypeScript blocks describe JSON data except the explicitly internal adapter interface. IDs are opaque strings; production listing IDs preserve existing UUIDs. Times are UTC RFC3339 strings; absent timestamps are null. Example IDs and content are synthetic.

```ts
type SourceRef = {
  sourceId: string
  externalId: string
  name: string
  url: string
}
type Location =
  | { kind: 'verified'; point: Point; evidence: string; verifiedAt: string }
  | {
      kind: 'unverified'
      point: Point
      precision: 'unknown' | 'approximate'
      sourceId: string
    }
  | { kind: 'municipality'; municipalityId: string }
  | { kind: 'unknown' }
type ListingProjection = {
  id: string
  titleJa: string
  sourceRefs: SourceRef[]
  primarySourceUrl: string
  transactionType: 'sale' | 'rent' | 'both' | 'unknown'
  salePriceJpy: number | null
  rentMonthlyJpy: number | null
  priceNoteJa: string | null
  propertyType: string | null
  floorAreaM2: number | null
  landAreaM2: number | null
  prefecture: string | null
  municipalityId: string | null
  municipalityNameJa: string | null
  availability: 'available' | 'under_offer' | 'unavailable' | 'unknown'
  location: Location
  firstSeenAt: string | null
  lastSeenAt: string | null
  sourceCheckedAt: string | null
}
type MunicipalityGroup = {
  municipalityId: string
  nameJa: string
  listingIds: string[]
  count: number
  representativePoint: Point | null
  representativePointProvenance: string | null
}
type AreaResults = {
  area: SelectedArea
  showUnavailable: boolean
  mode: 'synthetic' | 'live'
  listings: ListingProjection[]
  municipalityGroups: MunicipalityGroup[]
  coverage: Coverage
  generatedAt: string
}
```

Money is nonnegative safe-integer yen in JSON; reject unsafe values rather than round Postgres bigint. Null is unknown, zero is explicitly free. Areas are positive finite square metres or null. Preserve the existing `price_jpy` as sale price and `source_checked_at` as last successful check; map them to `salePriceJpy`/`sourceCheckedAt`, add rent separately, and preserve `id`, Japanese fields and primary source attribution. Keep existing `status = draft | published | archived` editorial semantics independent of availability; the approved local API projection is separate from the existing published-only anonymous database view. No moderation writes come from imports. Legacy coordinates without verification evidence become unverified. No translations, raw observations, content hashes, leases or credentials enter this response. Distinct sale/rental offers retain distinct identities; `both` is only for a source explicitly offering both under one offer identity.

`sourceRefs` is nonempty; URLs must pass HTTP(S) and source-host validation. Only proven duplicate offers share a projection. Per-source observations retain independent successful-check/availability evidence privately; the displayed check time must conservatively represent the supporting projection, never a failed attempt. Null legacy observation times remain unknown rather than being backfilled with migration time. Unknown fields cannot erase existing valid values. Municipality IDs are stable namespaced reference keys, not display names. A group with no documented representative point remains list-accessible without a fabricated marker.

Concrete synthetic results response (POST `/api/area-results`, input in #2):

```json
{
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "showUnavailable": false,
  "mode": "synthetic",
  "listings": [
    {
      "id": "sample-sale-1",
      "titleJa": "サンプル売却情報",
      "sourceRefs": [
        {
          "sourceId": "fixture",
          "externalId": "sale-1",
          "name": "Sample source",
          "url": "https://example.invalid/offers/sale-1"
        }
      ],
      "primarySourceUrl": "https://example.invalid/offers/sale-1",
      "transactionType": "sale",
      "salePriceJpy": 0,
      "rentMonthlyJpy": null,
      "priceNoteJa": null,
      "propertyType": null,
      "floorAreaM2": null,
      "landAreaM2": null,
      "prefecture": null,
      "municipalityId": null,
      "municipalityNameJa": null,
      "availability": "unknown",
      "location": {
        "kind": "unverified",
        "point": { "latitude": 35.001, "longitude": 135 },
        "precision": "approximate",
        "sourceId": "fixture"
      },
      "firstSeenAt": "2026-10-15T00:00:00Z",
      "lastSeenAt": "2026-10-15T00:00:00Z",
      "sourceCheckedAt": "2026-10-15T00:00:00Z"
    }
  ],
  "municipalityGroups": [],
  "coverage": {
    "status": "unknown",
    "lastSuccessfulCheckAt": null,
    "freshUntil": null,
    "scopeKey": null,
    "caveats": ["Sample data; location unverified"]
  },
  "generatedAt": "2026-10-15T00:00:00Z"
}
```

Location fixture substitutions use the same listing shape: verified `{"kind":"verified","point":{"latitude":35,"longitude":135},"evidence":"synthetic verification","verifiedAt":"2026-10-15T00:00:00Z"}`; municipality `{"kind":"municipality","municipalityId":"fixture:municipality-1"}`; unknown `{"kind":"unknown"}`. Municipality variant must also set matching municipality identity/name fields and add `{"municipalityId":"fixture:municipality-1","nameJa":"サンプル自治体","listingIds":["sample-sale-1"],"count":1,"representativePoint":{"latitude":35.1,"longitude":135},"representativePointProvenance":"Synthetic municipal office; boundary intersects circle"}` to `municipalityGroups`. The representative point is outside the example circle deliberately. These variants are fixture recipes, not additional DTOs.

## Shared job API

Use JSON under `/api`; no browser database writes. Mutation endpoints require allowed Origin plus a per-installation session/CSRF validation mechanism; reject untrusted/missing browser authorization with 403. Exact local credential provisioning belongs to #5 implementation. Browser receives no privileged database secret. All operations are local and polling-compatible.

| Operation                                     | Request                                          | Response                                                                    |
| --------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| POST `/api/import-requests`                   | `{area, intent: 'import'}` and `Idempotency-Key` | 202 `ImportRequest`; 200 for cached reuse                                   |
| GET `/api/import-requests/:requestId`         | none                                             | 200 `ImportRequest`                                                         |
| GET `/api/import-jobs/:jobId`                 | none                                             | 200 `ImportJob`                                                             |
| GET `/api/import-jobs?state=active`           | none                                             | 200 `{jobs: ImportJob[]}` including queued and running, oldest queued first |
| POST `/api/import-jobs/:jobId/cancel`         | `{}`                                             | 200 current `ImportJob`                                                     |
| POST `/api/import-requests/:requestId/cancel` | `{}`                                             | 200 current `ImportRequest`; #6 defines shared-work cancellation            |
| POST `/api/area-results`                      | #2 `AreaQuery`                                   | 200 `AreaResults`; read-only, no source requests                            |

```ts
type JobState =
  'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
type ApiError = { code: string; message: string; retryable: boolean }
type Coverage = {
  status: 'unknown' | 'partial' | 'complete'
  lastSuccessfulCheckAt: string | null
  freshUntil: string | null
  scopeKey: string | null
  caveats: string[]
}
type ImportRequest = {
  id: string
  area: SelectedArea
  intent: 'import' | 'manual_refresh' | 'continue'
  state: JobState
  disposition: 'created' | 'attached' | 'cached' | 'continued'
  jobIds: string[]
  pendingFollowUp: boolean
  createdAt: string
  finishedAt: string | null
  error: ApiError | null
}
type ImportJob = {
  id: string
  area: SelectedArea
  scopeKey: string
  state: JobState
  stage: 'queued' | 'discovering' | 'fetching' | 'saving' | 'finished'
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
  counts: {
    discovered: number
    checked: number
    added: number
    updated: number
    unchanged: number
    rejected: number
  }
  budget: {
    discoveryUsed: number
    discoveryLimit: number
    detailUsed: number
    detailLimit: number
  }
  sources: {
    sourceId: string
    state: JobState
    coverage: 'unknown' | 'partial' | 'complete'
    error: ApiError | null
  }[]
  coverage: Coverage
  reasons: string[]
  error: ApiError | null
  continuation: {
    available: boolean
    fromJobId: string | null
    restarted: boolean
    restartReason: string | null
  }
}
```

A request represents a user's intent; a job represents bounded shared execution. Base #5 creates one request and one job; #6 supplies attachment/cache/continuation semantics using these same fields. Freeze job area and scope at creation (enabled sources, adapter/query/reference versions and filters). `scopeKey` is an opaque durable fingerprint, not a client-supplied authority. Results always query the requested area, even when an attached job has a larger area. Default budgets are 10 discovery and 100 detail requests including retries; limits are persisted per job. Counts are nonnegative job-local values: unique discovered identities, successful detail checks, committed added/updated/unchanged projections and rejected observations. Retry attempts consume budget, not duplicate result counts. Counters never imply a known total; cumulative traversal coverage is separate from job-local counts.

Request state aggregates intent and may move from running to queued while a required follow-up waits; it is not a job execution transition. Queued jobs can become running or cancelled; running ends in any terminal state. Terminal jobs never reopen. Cancellation sets `cancelRequestedAt`; a running job remains running until active work settles. Terminal cancellation preserves committed counts, and repeated cancellation returns the current terminal snapshot. Calling cancel on a completed job does not rewrite its outcome. All terminal stages are finished. No-enabled-source is 409 `NO_ENABLED_SOURCES`, never an empty successful job. Unknown identifiers are 404; malformed area/input is 400 `INVALID_REQUEST`; reused key with different semantic input is 409 `IDEMPOTENCY_CONFLICT`. Errors use `{"error":{"code":"INVALID_REQUEST","message":"radiusKm must be greater than 0 and at most 10","retryable":false}}`. Persist idempotency mappings with requests; retries return the same request and do not schedule new work. Do not use coordinate rounding to equate different inputs.

Success means required work completed without source/record errors or deferred work; zero listings can succeed. Partial means useful work or saved resumable progress exists but required work is incomplete. Failed means required work could not produce useful progress; earlier saved area results remain available. Mixed source success/failure is partial. Coverage describes discovery traversal only: complete discovery plus deferred detail refresh can still mean a partial job. A terminal failed/cancelled/partial job cannot certify a new complete cache or advance a checkpoint. `lastSuccessfulCheckAt` is the last fully successful covering check, not this job's last attempt. Source caveats persist even on success.

### Concrete queued, running, empty, cancelled and failed examples

POST `/api/import-requests`, `Idempotency-Key: sample-import-1`:

```json
{
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "intent": "import"
}
```

202 response:

```json
{
  "id": "request-1",
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "intent": "import",
  "state": "queued",
  "disposition": "created",
  "jobIds": ["job-1"],
  "pendingFollowUp": false,
  "createdAt": "2026-10-15T00:00:00Z",
  "finishedAt": null,
  "error": null
}
```

GET `/api/import-jobs/job-1`, 200 queued snapshot:

```json
{
  "id": "job-1",
  "area": { "center": { "latitude": 35, "longitude": 135 }, "radiusKm": 5 },
  "scopeKey": "fixture-scope-v1",
  "state": "queued",
  "stage": "queued",
  "createdAt": "2026-10-15T00:00:00Z",
  "startedAt": null,
  "finishedAt": null,
  "cancelRequestedAt": null,
  "counts": {
    "discovered": 0,
    "checked": 0,
    "added": 0,
    "updated": 0,
    "unchanged": 0,
    "rejected": 0
  },
  "budget": {
    "discoveryUsed": 0,
    "discoveryLimit": 10,
    "detailUsed": 0,
    "detailLimit": 100
  },
  "sources": [
    {
      "sourceId": "fixture",
      "state": "queued",
      "coverage": "unknown",
      "error": null
    }
  ],
  "coverage": {
    "status": "unknown",
    "lastSuccessfulCheckAt": null,
    "freshUntil": null,
    "scopeKey": "fixture-scope-v1",
    "caveats": ["Configured source coverage only"]
  },
  "reasons": [],
  "error": null,
  "continuation": {
    "available": false,
    "fromJobId": null,
    "restarted": false,
    "restartReason": null
  }
}
```

The following JSON objects are explicit field replacements on that full snapshot to construct deterministic response fixtures (not HTTP PATCH responses). Unmentioned fields retain their base values; replace whole nested objects. All snapshots return HTTP 200:

```json
{
  "state": "running",
  "stage": "discovering",
  "startedAt": "2026-10-15T00:00:01Z",
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
      "coverage": "unknown",
      "error": null
    }
  ]
}
```

Empty success after one empty discovery page:

```json
{
  "state": "succeeded",
  "stage": "finished",
  "startedAt": "2026-10-15T00:00:01Z",
  "finishedAt": "2026-10-15T00:00:03Z",
  "budget": {
    "discoveryUsed": 1,
    "discoveryLimit": 10,
    "detailUsed": 0,
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
    "lastSuccessfulCheckAt": "2026-10-15T00:00:03Z",
    "freshUntil": "2026-10-16T00:00:03Z",
    "scopeKey": "fixture-scope-v1",
    "caveats": ["Configured source coverage only"]
  }
}
```

The corresponding area-results response is `{"area":{"center":{"latitude":35,"longitude":135},"radiusKm":5},"showUnavailable":false,"mode":"synthetic","listings":[],"municipalityGroups":[],"coverage":{"status":"complete","lastSuccessfulCheckAt":"2026-10-15T00:00:03Z","freshUntil":"2026-10-16T00:00:03Z","scopeKey":"fixture-scope-v1","caveats":["Configured source coverage only"]},"generatedAt":"2026-10-15T00:00:03Z"}`. The request becomes succeeded with that finished time. UI says Search finished, zero additions; it does not claim exhaustive inventory.

POST `/api/import-jobs/job-1/cancel` `{}` before execution returns:

```json
{
  "state": "cancelled",
  "stage": "finished",
  "cancelRequestedAt": "2026-10-15T00:00:01Z",
  "finishedAt": "2026-10-15T00:00:01Z",
  "sources": [
    {
      "sourceId": "fixture",
      "state": "cancelled",
      "coverage": "unknown",
      "error": null
    }
  ],
  "reasons": ["USER_CANCELLED"]
}
```

GET failed after a blocked first request:

```json
{
  "state": "failed",
  "stage": "finished",
  "startedAt": "2026-10-15T00:00:01Z",
  "finishedAt": "2026-10-15T00:00:03Z",
  "budget": {
    "discoveryUsed": 1,
    "discoveryLimit": 10,
    "detailUsed": 0,
    "detailLimit": 100
  },
  "sources": [
    {
      "sourceId": "fixture",
      "state": "failed",
      "coverage": "unknown",
      "error": {
        "code": "SOURCE_BLOCKED",
        "message": "Source access blocked",
        "retryable": false
      }
    }
  ],
  "reasons": ["SOURCE_BLOCKED"],
  "error": {
    "code": "SOURCE_BLOCKED",
    "message": "Source access blocked",
    "retryable": false
  }
}
```

Cancel and failure propagate to the sole base request with the same terminal time/error. Area-results remains a separate saved-data read; neither case clears older listings or successful-check times. Sanitized error codes also distinguish TIMEOUT, RATE_LIMITED, PARSE_ERROR and CONFIGURATION_ERROR; stack traces, raw URLs with credentials, bodies and secrets stay private.

## Internal source-adapter contract

The worker owns persistence, retries, cancellation, budgets and transport. Adapters do not create independent queues or bypass the supplied transport. This supersedes the nightly-plan scheduling suggestions while reusing its stable identities, money, availability and observation/projection separation.

```ts
type AdapterCapabilities = {
  sourceId: string
  adapterVersion: string
  queryVersion: string
  geography: 'circle' | 'municipality' | 'unsupported'
  dateOrdering: null | {
    field: 'publishedAt' | 'modifiedAt'
    descendingVerified: true
    overlapSeconds: number
    evidence: string
  }
  cursorVersion: string
  allowedHosts: string[]
}
type Candidate = {
  externalId: string
  transactionType: ListingProjection['transactionType']
  url: string
  location: Location
  municipalityId: string | null
  publishedAt: string | null
  modifiedAt: string | null
  relevance: 'known_inside' | 'plausible' | 'known_outside'
}
type DiscoveryPage = {
  candidates: Candidate[]
  nextCursor: string | null
  exhausted: boolean
  limitation: string | null
}
type SourceIdentity = { sourceId: string; externalId: string }
// Source-specific parsed evidence remains private and is not a browser DTO.
type DetailEvidence = {
  identity: SourceIdentity
  url: string
  fetchedAt: string
  payload: unknown
  provenance: Record<string, string>
}
type NormalizedFields = Pick<
  ListingProjection,
  | 'titleJa'
  | 'transactionType'
  | 'salePriceJpy'
  | 'rentMonthlyJpy'
  | 'priceNoteJa'
  | 'propertyType'
  | 'floorAreaM2'
  | 'landAreaM2'
  | 'prefecture'
  | 'municipalityId'
  | 'municipalityNameJa'
  | 'availability'
  | 'location'
>
type SourceObservation = {
  identity: SourceIdentity
  url: string
  adapterVersion: string
  sourceCheckedAt: string
  fields: Partial<NormalizedFields>
  provenance: Record<string, string>
  contentHash: string
}
type NormalizationResult =
  | { kind: 'accepted'; observation: SourceObservation }
  | { kind: 'rejected'; error: ApiError }
interface SourceAdapter {
  capabilities: AdapterCapabilities
  discover(
    input: { area: SelectedArea; queryKey: string; cursor: string | null },
    context: AdapterContext,
  ): Promise<DiscoveryPage>
  fetchDetail(
    candidate: Candidate,
    context: AdapterContext,
  ): Promise<DetailEvidence>
  normalize(evidence: DetailEvidence): NormalizationResult
}
```

`AdapterContext` provides AbortSignal, controlled clock and a worker-owned `request(kind: 'discovery' | 'detail', url, options)` transport. Every outbound attempt including retries, redirects and conditional checks is charged to that kind before dispatch; redirects also pass host/rate checks. No hidden adapter network calls. Feed records embedded in a charged discovery response can normalize without an invented detail request. `DetailEvidence` is private source-specific data plus source identity, validated URL, fetchedAt, and field provenance; fixtures substitute it at this boundary. `NormalizationResult` is either `{kind:'accepted', observation}` or `{kind:'rejected', error: ApiError}`. `observation` contains source identity, transaction identity, adapter version, successful-check time, normalized business fields corresponding to the projection, field provenance, and a content hash excluding observation times. Updates are field patches: omitted means no evidence, explicit null clears only a field whose removal is authoritatively established. Worker validates/merges against the saved observation and writes observation plus projection atomically. A provider's sale/rent variants need distinct offer keys if its native ID identifies a property rather than an offer.

Example discovery call: `{"area":{"center":{"latitude":35,"longitude":135},"radiusKm":5},"queryKey":"fixture-scope-v1","cursor":null}`. Result: `{"candidates":[{"externalId":"sale-1","transactionType":"sale","url":"https://example.invalid/offers/sale-1","location":{"kind":"unknown"},"municipalityId":null,"publishedAt":null,"modifiedAt":null,"relevance":"plausible"}],"nextCursor":"fixture-page-2","exhausted":false,"limitation":null}`. Detail normalization supplies the synthetic listing facts above under the same source offer identity. A final empty page returns `{"candidates":[],"nextCursor":null,"exhausted":true,"limitation":null}`. Result caps/unsupported geography instead supply a limitation and cannot certify traversal completion. Unknown location may be plausible only with scoped discovery evidence; known-outside candidates do not trigger detail requests.

Cursor invalidation raises typed `CURSOR_EXPIRED` or `CURSOR_INVALID`; blocked access, retryable transport and parser errors remain distinct. Cursors, evidence and query keys are stored privately with source/version/scope; clients continue by job ID, never by a raw source cursor. `exhausted` is a discovery signal, not permission to advance a checkpoint before required processing commits. Missing/unverified date ordering disables date stopping. #6 owns checkpoint advancement, equal-date overlap, request allocation, and continuation behavior. Source-specific permission/rate evidence is configuration required by #4, never implied by capabilities.
