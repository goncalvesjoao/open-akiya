import { workerRequest, type TransportOptions } from './transport'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import {
  areasIntersect,
  distanceMetres,
  isSelectedArea,
} from '../shared/geography'
import type {
  AreaResults,
  Coverage,
  ListingProjection,
  SelectedArea,
} from '../shared/listings'
import type { ImportJob, ImportRequest, Operation } from '../shared/desktop'
import {
  syntheticAdapter,
  type SourceAdapter,
  type Candidate,
  type AdapterContext,
  type SourceObservation,
  type NormalizedFields,
} from './adapter'
import { invalid, LocalApiError, safeError } from './errors'
import { listingProjection, savedListingProjection } from './projection'
import { municipalityReference } from './municipalities'
import { locationMatchesArea } from './listing-area'
import type { MunicipalityGroup } from '../shared/listings'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    invalid('Invalid identifier')
  return value
}
const active = (job: Pick<ImportJob, 'state'>) =>
  job.state === 'queued' || job.state === 'running'
const coverage = (scopeKey: string | null): Coverage => ({
  status: 'unknown',
  lastSuccessfulCheckAt: null,
  freshUntil: null,
  scopeKey,
  caveats: ['Synthetic fixtures only; no real inventory or source coverage.'],
})
type Progress = {
  sourceIndex: number
  resumeSources?: Record<string, Progress>
  cursor: string | null
  candidates: Candidate[]
  candidateIndex: number
  exhausted: boolean
  limitation: string | null
  discovered: string[]
  completed: string[]
  sourceSaved?: number
  refresh?: {
    sourceIndex: number
    candidate: Candidate
    checkedAt: string | null
  }[]
  reusedRefresh?: NonNullable<Progress['refresh']>
  deferredRefresh?: NonNullable<Progress['refresh']>
  refreshSaved?: Record<number, number>
  savedBySource?: Record<number, number>
  refreshIndex?: number
  detailClassUsed?: { new: number; refresh: number }
  nextDetailClass?: 'new' | 'refresh'
  refreshReservation?: number
  refreshAttemptLimit?: number
  visitedCursors?: string[]
  oldestDetailCheckAt?: number
}
function usefulProgress(progress: Progress, errorCode?: string): boolean {
  return (
    (progress.sourceSaved ?? 0) > 0 ||
    (!['INVALID_REQUEST', 'PARSE_ERROR', 'INTERNAL_ERROR'].includes(
      errorCode ?? '',
    ) &&
      (progress.candidateIndex < progress.candidates.length ||
        (!progress.exhausted && progress.cursor !== null)))
  )
}
type RuntimeOptions = TransportOptions & {
  adapters?: SourceAdapter[]
  now?: () => number
  leaseMs?: number
  discoveryLimit?: number
  detailLimit?: number
  refreshReservation?: number
  areaFreshnessMs?: number
  detailFreshnessMs?: number
  referenceVersion?: string
  fixedFilters?: Record<string, string | number | boolean>
}

// Worker API seam: all SQLite access and execution ownership remain outside renderer.
export class ImportRuntime {
  private db: DatabaseSync
  private readonly owner = randomUUID()
  private readonly adapters: SourceAdapter[]
  private readonly areaFreshnessMs: number
  private readonly detailFreshnessMs: number
  private readonly referenceVersion: string
  private readonly fixedFilters: Record<string, string | number | boolean>
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly limits: { discoveryLimit: number; detailLimit: number }
  private readonly refreshReservation: number
  private readonly transportOptions: TransportOptions
  private readonly transportQueue = { tail: Promise.resolve() }
  private stopping = false
  private executing = false
  private executingJobId: string | undefined
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private controller: AbortController | undefined
  constructor(path: string, delayMs = 300, options: RuntimeOptions = {}) {
    this.limits = {
      discoveryLimit: options.discoveryLimit ?? 10,
      detailLimit: options.detailLimit ?? 100,
    }
    if (
      Object.values(this.limits).some(
        (limit) => !Number.isSafeInteger(limit) || limit < 1,
      )
    )
      invalid('Invalid import budget configuration')
    this.refreshReservation = options.refreshReservation ?? 0.25
    if (
      !Number.isFinite(this.refreshReservation) ||
      this.refreshReservation < 0 ||
      this.refreshReservation > 1
    )
      invalid('Invalid refresh reservation')
    this.areaFreshnessMs = options.areaFreshnessMs ?? 86400000
    this.detailFreshnessMs = options.detailFreshnessMs ?? 86400000
    if (
      [this.areaFreshnessMs, this.detailFreshnessMs].some(
        (value) => !Number.isFinite(value) || value < 0,
      )
    )
      invalid('Invalid freshness configuration')
    this.referenceVersion = options.referenceVersion ?? 'synthetic-v1'
    this.fixedFilters = options.fixedFilters ?? { residential: true }
    this.transportOptions = options
    this.adapters = options.adapters ?? [syntheticAdapter(delayMs)]
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? 30000
    this.db = new DatabaseSync(path)
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS import_jobs_v2 (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, scope TEXT NOT NULL, progress TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS active_import_jobs_v2 ON import_jobs_v2(state) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS import_continuations (from_job_id TEXT PRIMARY KEY REFERENCES import_jobs_v2(id), job_id TEXT UNIQUE NOT NULL REFERENCES import_jobs_v2(id));
      CREATE TABLE IF NOT EXISTS import_requests_v2 (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, semantic TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES import_jobs_v2(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executor_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(source_id,external_id));
      CREATE TABLE IF NOT EXISTS listing_discovery_areas (listing_id TEXT NOT NULL REFERENCES listings(id), area TEXT NOT NULL, PRIMARY KEY(listing_id,area));
      CREATE TABLE IF NOT EXISTS source_host_limits (host TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_traversals (job_id TEXT NOT NULL, source_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,source_id));
      CREATE TABLE IF NOT EXISTS source_task_state (job_id TEXT NOT NULL, source_id TEXT NOT NULL, retry_at INTEGER, PRIMARY KEY(job_id,source_id));
      CREATE TABLE IF NOT EXISTS offer_keys (source_id TEXT NOT NULL, external_id TEXT NOT NULL, transaction_type TEXT NOT NULL, listing_id TEXT NOT NULL REFERENCES listings(id), PRIMARY KEY(source_id,external_id,transaction_type));
      INSERT OR IGNORE INTO offer_keys SELECT source_id, coalesce(json_extract(data,'$.sourceRefs[0].externalId'),external_id), json_extract(data,'$.transactionType'),id FROM listings;
      CREATE TABLE IF NOT EXISTS offer_observations (source_id TEXT NOT NULL, external_id TEXT NOT NULL, transaction_type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source_id,external_id,transaction_type));
      CREATE TABLE IF NOT EXISTS offer_observation_history (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, transaction_type TEXT NOT NULL, data TEXT NOT NULL);
      INSERT INTO offer_observation_history(source_id,external_id,transaction_type,data) SELECT o.source_id,o.external_id,o.transaction_type,o.data FROM offer_observations o WHERE NOT EXISTS (SELECT 1 FROM offer_observation_history h WHERE h.source_id=o.source_id AND h.external_id=o.external_id AND h.transaction_type=o.transaction_type);
      CREATE TABLE IF NOT EXISTS observations (source_id TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source_id,external_id));`)
    this.schedule()
  }
  private time() {
    return new Date(this.now()).toISOString()
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private activeJobs(): ImportJob[] {
    return this.db
      .prepare(
        "SELECT data FROM import_jobs_v2 WHERE state IN ('queued','running') ORDER BY rowid",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)))
  }
  list(input: unknown): { jobs: ImportJob[] } {
    if (
      !record(input) ||
      input.state !== 'active' ||
      Object.keys(input).length !== 1
    )
      invalid('Invalid active-job query')
    return { jobs: this.activeJobs() }
  }
  inspect(input: unknown): ImportJob {
    const row = this.db
      .prepare('SELECT data FROM import_jobs_v2 WHERE id=?')
      .get(identifier(input))
    if (!row) throw new LocalApiError(404, 'NOT_FOUND', 'Import not found')
    return JSON.parse(String(row.data))
  }
  inspectRequest(input: unknown): ImportRequest {
    const row = this.db
      .prepare('SELECT data FROM import_requests_v2 WHERE id=?')
      .get(identifier(input))
    if (!row)
      throw new LocalApiError(404, 'NOT_FOUND', 'Import request not found')
    return JSON.parse(String(row.data))
  }
  private semantics() {
    return {
      sources: this.adapters
        .map((adapter) => adapter.capabilities)
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      filters: Object.fromEntries(
        Object.entries(this.fixedFilters).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
      referenceVersion: this.referenceVersion,
    }
  }
  private scope(area: SelectedArea) {
    return { area, ...this.semantics() }
  }
  private detailScope(adapter: SourceAdapter) {
    return JSON.stringify({
      source: adapter.capabilities,
      filters: this.semantics().filters,
      referenceVersion: this.referenceVersion,
    })
  }
  private covering(
    area: SelectedArea,
    freshOnly = false,
    exclude?: string,
    includeIncomplete = false,
  ): ImportJob | undefined {
    const semantics = this.semantics()
    for (const row of this.db
      .prepare(
        `SELECT data,scope,progress FROM import_jobs_v2 WHERE state IN ('succeeded','partial','failed','cancelled') AND CASE WHEN json_valid(data) THEN json_extract(data,'$.coverage.status') IS NOT NULL ELSE 0 END ORDER BY rowid DESC`,
      )
      .all()) {
      const job: ImportJob = JSON.parse(String(row.data))
      const stored = JSON.parse(String(row.scope))
      delete stored.area
      if (
        job.id === exclude ||
        job.reasons.includes('CACHE_REUSED') ||
        JSON.stringify(stored) !== JSON.stringify(semantics) ||
        (!includeIncomplete &&
          (job.state !== 'succeeded' ||
            job.coverage.status !== 'complete' ||
            !job.coverage.lastSuccessfulCheckAt)) ||
        distanceMetres(area.center, job.area.center) + area.radiusKm * 1000 >
          job.area.radiusKm * 1000 + 1e-8
      )
        continue
      if (job.coverage.lastSuccessfulCheckAt && job.coverage.freshUntil) {
        const progress: Progress = JSON.parse(String(row.progress))
        const expires = Math.min(
          Date.parse(job.coverage.freshUntil),
          Date.parse(job.coverage.lastSuccessfulCheckAt) + this.areaFreshnessMs,
          progress.oldestDetailCheckAt === undefined
            ? Infinity
            : progress.oldestDetailCheckAt + this.detailFreshnessMs,
        )
        job.coverage.freshUntil = new Date(expires).toISOString()
      }
      if (
        freshOnly &&
        (!job.coverage.freshUntil ||
          this.now() >= Date.parse(job.coverage.freshUntil))
      )
        continue
      return job
    }
  }
  private resultsCoverage(area: SelectedArea): Coverage {
    const successful = this.covering(area)
    const latest = this.covering(area, false, undefined, true)
    const evidence = successful?.coverage ?? latest?.coverage ?? coverage(null)
    return {
      ...evidence,
      caveats: [
        ...new Set([...evidence.caveats, ...(latest?.coverage.caveats ?? [])]),
      ],
    }
  }
  private save(job: ImportJob) {
    if (!active(job))
      job.continuation.available =
        Object.keys(this.pendingSources(job)).length > 0
    // Another worker may have persisted cancellation after this snapshot was read.
    this.db
      .prepare(
        `UPDATE import_jobs_v2 SET state=?,data=CASE
        WHEN json_extract(data,'$.cancelRequestedAt') IS NOT NULL THEN
          json_set(?, '$.cancelRequestedAt', json_extract(data,'$.cancelRequestedAt'),
            '$.reasons', json_extract(data,'$.reasons'))
        ELSE ? END WHERE id=?`,
      )
      .run(job.state, JSON.stringify(job), JSON.stringify(job), job.id)
    const rows = this.db
      .prepare('SELECT id,data FROM import_requests_v2 WHERE job_id=?')
      .all(job.id)
    for (const row of rows) {
      const request: ImportRequest = JSON.parse(String(row.data))
      if (!active(request)) continue
      request.state = job.state
      request.finishedAt = job.finishedAt
      request.error = job.error
      this.db
        .prepare(
          "UPDATE import_requests_v2 SET data=? WHERE id=? AND json_extract(data,'$.state') IN ('queued','running')",
        )
        .run(JSON.stringify(request), row.id)
    }
  }
  private coveringJob(scope: string): ImportJob | undefined {
    const { area: requestedArea, ...requestedSemantics } = JSON.parse(scope)
    for (const job of this.activeJobs()) {
      if (job.cancelRequestedAt) continue
      const { area: coveringArea, ...semantics } = JSON.parse(
        String(
          this.db
            .prepare('SELECT scope FROM import_jobs_v2 WHERE id=?')
            .get(job.id)!.scope,
        ),
      )
      if (
        JSON.stringify(semantics) === JSON.stringify(requestedSemantics) &&
        distanceMetres(coveringArea.center, requestedArea.center) +
          requestedArea.radiusKm * 1000 <=
          coveringArea.radiusKm * 1000 + 1e-8
      )
        return job
    }
  }

  createRequest(input: unknown): ImportRequest {
    if (record(input) && input.intent === 'continue')
      return this.continueRequest(input)
    if (
      !record(input) ||
      !isSelectedArea(input.area) ||
      input.intent !== 'import' ||
      Object.keys(input).some(
        (key) => !['area', 'intent', 'idempotencyKey'].includes(key),
      )
    )
      invalid('Invalid selected area or import intent')
    const key = identifier(input.idempotencyKey)
    const area: SelectedArea = {
      center: {
        latitude: input.area.center.latitude,
        longitude: input.area.center.longitude,
      },
      radiusKm: input.area.radiusKm,
    }
    const semantic = JSON.stringify({ area, intent: 'import' })
    const result = this.transaction(() => {
      const old = this.db
        .prepare('SELECT semantic,data FROM import_requests_v2 WHERE key=?')
        .get(key)
      if (old) {
        if (old.semantic !== semantic)
          throw new LocalApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key already belongs to different input',
          )
        return JSON.parse(String(old.data)) as ImportRequest
      }
      if (!this.adapters.length)
        throw new LocalApiError(409, 'NO_ENABLED_SOURCES', 'No enabled sources')
      const cached = this.covering(area, true)
      if (cached) {
        const request: ImportRequest = {
          id: randomUUID(),
          area,
          intent: 'import',
          state: 'succeeded',
          disposition: 'cached',
          jobIds: [cached.id],
          pendingFollowUp: false,
          createdAt: this.time(),
          finishedAt: this.time(),
          error: null,
        }
        this.db
          .prepare('INSERT INTO import_requests_v2 VALUES (?,?,?,?,?)')
          .run(request.id, key, semantic, cached.id, JSON.stringify(request))
        return request
      }
      const scope = JSON.stringify(this.scope(area))
      const scopeKey = createHash('sha256').update(scope).digest('hex')
      const covering = this.coveringJob(scope)
      const job: ImportJob = covering ?? {
        id: randomUUID(),
        area,
        scopeKey,
        state: 'queued',
        stage: 'queued',
        createdAt: this.time(),
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        counts: {
          discovered: 0,
          checked: 0,
          added: 0,
          updated: 0,
          unchanged: 0,
          rejected: 0,
        },
        budget: {
          discoveryUsed: 0,
          discoveryLimit: this.limits.discoveryLimit,
          detailUsed: 0,
          detailLimit: this.limits.detailLimit,
        },
        sources: this.adapters.map((adapter) => ({
          sourceId: adapter.capabilities.sourceId,
          state: 'queued',
          coverage: 'unknown',
          error: null,
        })),
        coverage: coverage(scopeKey),
        reasons: [],
        error: null,
        continuation: {
          available: false,
          fromJobId: null,
          restarted: false,
          restartReason: null,
        },
      }
      const progress: Progress = {
        sourceIndex: 0,
        cursor: null,
        candidates: [],
        candidateIndex: 0,
        exhausted: false,
        limitation: null,
        discovered: [],
        completed: [],
        refreshReservation: this.refreshReservation,
      }
      const request: ImportRequest = {
        id: randomUUID(),
        area,
        intent: 'import',
        state: job.state,
        disposition: covering ? 'attached' : 'created',
        jobIds: [job.id],
        pendingFollowUp: false,
        createdAt: this.time(),
        finishedAt: null,
        error: null,
      }
      if (!covering)
        this.db
          .prepare('INSERT INTO import_jobs_v2 VALUES (?,?,?,?,?)')
          .run(
            job.id,
            job.state,
            JSON.stringify(job),
            scope,
            JSON.stringify(progress),
          )
      this.db
        .prepare('INSERT INTO import_requests_v2 VALUES (?,?,?,?,?)')
        .run(request.id, key, semantic, job.id, JSON.stringify(request))
      return request
    })
    this.schedule()
    return result
  }
  private savedSources(job: ImportJob): Record<string, Progress> {
    const row = this.db
      .prepare('SELECT progress FROM import_jobs_v2 WHERE id=?')
      .get(job.id)!
    const current: Progress = JSON.parse(String(row.progress))
    const saved: Record<string, Progress> = { ...current.resumeSources }
    for (const entry of this.db
      .prepare('SELECT source_id,data FROM source_traversals WHERE job_id=?')
      .all(job.id))
      saved[String(entry.source_id)] = JSON.parse(String(entry.data))
    if (current.sourceIndex < job.sources.length)
      saved[job.sources[current.sourceIndex].sourceId] = current
    return saved
  }
  private pendingSources(job: ImportJob): Record<string, Progress> {
    const saved = this.savedSources(job)
    return Object.fromEntries(
      job.sources.flatMap((source, index) => {
        if (source.state === 'succeeded') return []
        const progress = saved[source.sourceId] ?? {
          sourceIndex: index,
          cursor: null,
          candidates: [],
          candidateIndex: 0,
          exhausted: false,
          limitation: null,
          discovered: [],
          completed: [],
        }
        const pending =
          progress.candidateIndex < progress.candidates.length ||
          !progress.exhausted ||
          progress.limitation !== null
        return pending
          ? [
              [
                source.sourceId,
                { ...progress, sourceIndex: index, resumeSources: undefined },
              ],
            ]
          : []
      }),
    )
  }
  private continueRequest(input: Record<string, unknown>): ImportRequest {
    if (
      Object.keys(input).some(
        (key) => !['intent', 'fromJobId', 'idempotencyKey'].includes(key),
      )
    )
      invalid('Continuation cannot replace the saved area or scope')
    const fromJobId = identifier(input.fromJobId)
    const key = identifier(input.idempotencyKey)
    const semantic = JSON.stringify({ intent: 'continue', fromJobId })
    const result = this.transaction(() => {
      const prior = this.db
        .prepare('SELECT semantic,data FROM import_requests_v2 WHERE key=?')
        .get(key)
      if (prior) {
        if (prior.semantic !== semantic)
          throw new LocalApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key already belongs to different input',
          )
        return JSON.parse(String(prior.data)) as ImportRequest
      }
      const original = this.inspect(fromJobId)
      if (active(original))
        throw new LocalApiError(
          409,
          'JOB_NOT_TERMINAL',
          'Import is still active',
        )
      const existing = this.db
        .prepare('SELECT job_id FROM import_continuations WHERE from_job_id=?')
        .get(fromJobId)
      let job: ImportJob
      if (existing) job = this.inspect(String(existing.job_id))
      else {
        const pending = this.pendingSources(original)
        if (!Object.keys(pending).length)
          throw new LocalApiError(
            409,
            'NOT_CONTINUABLE',
            'Import has no pending work',
          )
        const row = this.db
          .prepare('SELECT scope,progress FROM import_jobs_v2 WHERE id=?')
          .get(fromJobId)!
        const scope = JSON.parse(String(row.scope))
        if (
          scope.sources.some(
            (source: { sourceId: string }) =>
              !this.adapters.some(
                (adapter) => adapter.capabilities.sourceId === source.sourceId,
              ),
          )
        )
          throw new LocalApiError(
            409,
            'CONFIGURATION_ERROR',
            'Saved source configuration is unavailable',
          )
        let restarted = false
        const sources = scope.sources.map(
          (source: { sourceId: string }, index: number) => {
            const capabilities = this.adapters.find(
              (adapter) => adapter.capabilities.sourceId === source.sourceId,
            )!.capabilities
            if (JSON.stringify(source) !== JSON.stringify(capabilities)) {
              restarted = true
              const saved = this.savedSources(original)[source.sourceId]
              pending[source.sourceId] = {
                sourceIndex: index,
                cursor: null,
                candidates: [],
                candidateIndex: 0,
                exhausted: false,
                limitation: null,
                discovered: saved?.discovered ?? [],
                completed: saved?.completed ?? [],
              }
            }
            return capabilities
          },
        )
        const continuedScope = JSON.stringify({ ...scope, sources })
        const scopeKey = createHash('sha256')
          .update(continuedScope)
          .digest('hex')
        job = {
          ...original,
          scopeKey,
          id: randomUUID(),
          state: 'queued',
          stage: 'queued',
          createdAt: this.time(),
          startedAt: null,
          finishedAt: null,
          cancelRequestedAt: null,
          counts: {
            discovered: 0,
            checked: 0,
            added: 0,
            updated: 0,
            unchanged: 0,
            rejected: 0,
          },
          budget: { ...this.limits, discoveryUsed: 0, detailUsed: 0 },
          sources: original.sources.map((source) =>
            pending[source.sourceId]
              ? { ...source, state: 'queued', error: null }
              : source,
          ),
          coverage: { ...original.coverage, status: 'partial', scopeKey },
          reasons: restarted ? ['SOURCE_CONFIGURATION_CHANGED'] : [],
          error: null,
          continuation: {
            available: false,
            fromJobId,
            restarted,
            restartReason: restarted ? 'SOURCE_CONFIGURATION_CHANGED' : null,
          },
        }
        const previous: Progress = JSON.parse(String(row.progress))
        const progress: Progress = {
          ...previous,
          sourceIndex: 0,
          candidates: [],
          candidateIndex: 0,
          cursor: null,
          exhausted: false,
          limitation: null,
          resumeSources: pending,
        }
        this.db
          .prepare('INSERT INTO import_jobs_v2 VALUES (?,?,?,?,?)')
          .run(
            job.id,
            job.state,
            JSON.stringify(job),
            continuedScope,
            JSON.stringify(progress),
          )
        this.db
          .prepare('INSERT INTO import_continuations VALUES (?,?)')
          .run(fromJobId, job.id)
      }
      const request: ImportRequest = {
        id: randomUUID(),
        area: job.area,
        intent: 'continue',
        state: job.state,
        disposition: 'continued',
        jobIds: [job.id],
        pendingFollowUp: false,
        createdAt: this.time(),
        finishedAt: job.finishedAt,
        error: job.error,
      }
      this.db
        .prepare('INSERT INTO import_requests_v2 VALUES (?,?,?,?,?)')
        .run(request.id, key, semantic, job.id, JSON.stringify(request))
      return request
    })
    this.schedule()
    return result
  }
  private requestJobCancellation(job: ImportJob): ImportJob {
    if (!active(job)) return job
    job.cancelRequestedAt ??= this.time()
    if (!job.reasons.includes('USER_CANCELLED'))
      job.reasons.push('USER_CANCELLED')
    if (job.state === 'queued') {
      job.state = 'cancelled'
      job.stage = 'finished'
      job.finishedAt = this.time()
      job.sources.forEach((source) => {
        source.state = 'cancelled'
      })
    }
    this.save(job)
    return job
  }
  cancel(input: unknown): ImportJob {
    const job = this.transaction(() =>
      this.requestJobCancellation(this.inspect(input)),
    )
    if (job.state === 'running' && this.executingJobId === job.id)
      this.controller?.abort()
    return job
  }
  private cancelRequest(input: unknown): ImportRequest {
    const request = this.transaction(() => {
      const request = this.inspectRequest(input)
      if (!active(request)) return request
      request.state = 'cancelled'
      request.pendingFollowUp = false
      request.finishedAt = this.time()
      request.error = null
      this.db
        .prepare('UPDATE import_requests_v2 SET data=? WHERE id=?')
        .run(JSON.stringify(request), request.id)
      const jobId = request.jobIds[request.jobIds.length - 1]
      const owners = this.db
        .prepare('SELECT data FROM import_requests_v2 WHERE job_id=?')
        .all(jobId)
        .some((row) => active(JSON.parse(String(row.data))))
      if (!owners) this.requestJobCancellation(this.inspect(jobId))
      return request
    })
    const jobId = request.jobIds[request.jobIds.length - 1]
    if (this.executingJobId === jobId && this.inspect(jobId).cancelRequestedAt)
      this.controller?.abort()
    return request
  }
  results(input: unknown): AreaResults {
    if (
      !record(input) ||
      !isSelectedArea(input.area) ||
      typeof input.showUnavailable !== 'boolean'
    )
      invalid('Invalid area query')
    const { area, showUnavailable } = input
    const listings: ListingProjection[] = this.db
      .prepare('SELECT data FROM listings')
      .all()
      .map((row) => savedListingProjection(JSON.parse(String(row.data))))
    const visible = listings.filter(
      (listing) =>
        (showUnavailable || listing.availability !== 'unavailable') &&
        (listing.location.kind === 'unknown'
          ? this.db
              .prepare(
                'SELECT area FROM listing_discovery_areas WHERE listing_id=?',
              )
              .all(listing.id)
              .some((row) => {
                const scope: SelectedArea = JSON.parse(String(row.area))
                return areasIntersect(area, scope)
              })
          : locationMatchesArea(listing.location, area)),
    )
    const groups = new Map<string, MunicipalityGroup>()
    for (const listing of visible) {
      if (listing.location.kind !== 'municipality') continue
      const municipalityId = listing.location.municipalityId
      const reference = municipalityReference(municipalityId, area)!
      const group = groups.get(municipalityId) ?? {
        municipalityId,
        nameJa: listing.municipalityNameJa ?? municipalityId,
        listingIds: [],
        count: 0,
        representativePoint: reference.representativePoint,
        representativePointProvenance: reference.representativePointProvenance,
      }
      group.listingIds.push(listing.id)
      group.count = group.listingIds.length
      groups.set(municipalityId, group)
    }
    return {
      area,
      showUnavailable,
      mode: 'synthetic',
      listings: visible,
      municipalityGroups: [...groups.values()],
      coverage: this.resultsCoverage(area),
      generatedAt: this.time(),
    }
  }
  private schedule(delayMs = 25) {
    if (this.stopping || this.executing) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, delayMs)
  }
  private claim(): ImportJob | undefined {
    // Idle workers only read the small active index. Recheck under the write
    // transaction before claiming: another process may win after these reads.
    if (!this.nextJob() || this.leasedElsewhere()) return
    return this.transaction(() => {
      if (this.leasedElsewhere()) return
      const row = this.nextJob()
      if (!row) return
      const job: ImportJob = JSON.parse(String(row.data))
      this.db
        .prepare(
          'INSERT INTO executor_v2 VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,expires=excluded.expires',
        )
        .run(this.owner, this.now() + this.leaseMs)
      job.state = 'running'
      job.startedAt ??= this.time()
      this.save(job)
      return job
    })
  }
  private nextJob() {
    return this.db
      .prepare(
        "SELECT data FROM import_jobs_v2 WHERE state IN ('queued','running') ORDER BY rowid LIMIT 1",
      )
      .get()
  }
  private leasedElsewhere(): boolean {
    const lease = this.db
      .prepare('SELECT owner,expires FROM executor_v2 WHERE singleton=1')
      .get()
    return (
      !!lease &&
      lease.owner !== this.owner &&
      Number(lease.expires) > this.now()
    )
  }
  private owned(): boolean {
    const row = this.db
      .prepare('SELECT owner,expires FROM executor_v2 WHERE singleton=1')
      .get()
    return row?.owner === this.owner && Number(row.expires) > this.now()
  }
  private ensure(job: ImportJob) {
    if (
      this.stopping ||
      !this.owned() ||
      this.controller?.signal.aborted ||
      this.inspect(job.id).state !== 'running' ||
      this.inspect(job.id).cancelRequestedAt
    )
      throw new Error('Execution interrupted')
  }
  private saveProgress(job: ImportJob, progress: Progress) {
    this.save(job)
    this.db
      .prepare('UPDATE import_jobs_v2 SET progress=? WHERE id=?')
      .run(JSON.stringify(progress), job.id)
  }
  private context(
    job: ImportJob,
    adapter: SourceAdapter,
    progress: Progress,
    detailClass: 'new' | 'refresh' = 'new',
  ): AdapterContext {
    return {
      signal: this.controller!.signal,
      now: () => this.time(),
      request: workerRequest({
        hosts: adapter.capabilities.allowedHosts,
        signal: this.controller!.signal,
        now: this.now,
        ensure: () => this.ensure(job),
        options: this.transportOptions,
        queue: this.transportQueue,
        next: (host) =>
          Math.max(
            Number(
              this.db
                .prepare('SELECT next_at FROM source_host_limits WHERE host=?')
                .get(host)?.next_at ?? 0,
            ),
            Number(
              this.db
                .prepare(
                  'SELECT retry_at FROM source_task_state WHERE job_id=? AND source_id=?',
                )
                .get(job.id, adapter.capabilities.sourceId)?.retry_at ?? 0,
            ),
          ),
        saveNext: (host, time) => {
          this.db
            .prepare(
              'INSERT INTO source_host_limits VALUES (?,?) ON CONFLICT(host) DO UPDATE SET next_at=excluded.next_at',
            )
            .run(host, time)
        },
        retry: (time) => {
          this.db
            .prepare(
              'INSERT INTO source_task_state VALUES (?,?,?) ON CONFLICT(job_id,source_id) DO UPDATE SET retry_at=excluded.retry_at',
            )
            .run(job.id, adapter.capabilities.sourceId, time)
        },
        account: (kind) => {
          const used = kind === 'discovery' ? 'discoveryUsed' : 'detailUsed'
          const limit = kind === 'discovery' ? 'discoveryLimit' : 'detailLimit'
          if (job.budget[used] >= job.budget[limit])
            throw new LocalApiError(
              409,
              'BUDGET_EXHAUSTED',
              'Import request budget exhausted',
            )
          if (
            kind === 'detail' &&
            detailClass === 'refresh' &&
            progress.refreshAttemptLimit !== undefined &&
            job.budget.detailUsed >= progress.refreshAttemptLimit
          )
            throw new LocalApiError(
              409,
              'BUDGET_EXHAUSTED',
              'Reserved refresh request capacity exhausted',
            )
          job.budget[used]++
          if (kind === 'detail') {
            progress.detailClassUsed![detailClass]++
            progress.nextDetailClass =
              detailClass === 'refresh' ? 'new' : 'refresh'
          }
          this.saveProgress(job, progress)
        },
      }),
    }
  }
  private commit(
    job: ImportJob,
    observation: SourceObservation,
    adapter: SourceAdapter,
    candidate: Candidate,
  ) {
    if (
      observation.identity.sourceId !== adapter.capabilities.sourceId ||
      observation.identity.externalId !== candidate.externalId ||
      observation.url !== candidate.url ||
      !observation.contentHash ||
      typeof observation.sourceCheckedAt !== 'string' ||
      !Number.isFinite(Date.parse(observation.sourceCheckedAt)) ||
      Date.parse(observation.sourceCheckedAt) > this.now() ||
      !record(observation.fields) ||
      !record(observation.provenance)
    )
      invalid('Invalid source observation')
    identifier(observation.identity.externalId)
    let url: URL
    try {
      url = new URL(observation.url)
    } catch {
      invalid('Invalid source URL')
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !adapter.capabilities.allowedHosts.includes(url.hostname) ||
      !['sale', 'rent', 'both', 'unknown'].includes(candidate.transactionType)
    )
      invalid('Invalid source offer identity')
    const fieldNames: (keyof NormalizedFields)[] = [
      'titleJa',
      'transactionType',
      'salePriceJpy',
      'rentMonthlyJpy',
      'priceNoteJa',
      'propertyType',
      'floorAreaM2',
      'landAreaM2',
      'prefecture',
      'municipalityId',
      'municipalityNameJa',
      'availability',
      'location',
    ]
    const fields: Partial<NormalizedFields> = Object.fromEntries(
      fieldNames
        .filter((key) => observation.fields[key] !== undefined)
        .map((key) => [key, observation.fields[key]]),
    )
    if (
      (fields.salePriceJpy !== undefined &&
        fields.salePriceJpy !== null &&
        (!Number.isSafeInteger(fields.salePriceJpy) ||
          fields.salePriceJpy < 0)) ||
      (fields.rentMonthlyJpy !== undefined &&
        fields.rentMonthlyJpy !== null &&
        (!Number.isSafeInteger(fields.rentMonthlyJpy) ||
          fields.rentMonthlyJpy < 0))
    )
      invalid('Invalid source money')
    let prior = this.db
      .prepare(
        'SELECT listings.data FROM listings JOIN offer_keys ON listings.id=offer_keys.listing_id WHERE offer_keys.source_id=? AND offer_keys.external_id=? AND transaction_type=?',
      )
      .get(
        observation.identity.sourceId,
        observation.identity.externalId,
        candidate.transactionType,
      )
    const duplicate = observation.confirmedDuplicateOf
    if (duplicate !== undefined) {
      if (
        !record(duplicate) ||
        typeof duplicate.evidence !== 'string' ||
        !duplicate.evidence.trim() ||
        duplicate.sourceId === observation.identity.sourceId
      )
        invalid('Invalid confirmed duplicate evidence')
      identifier(duplicate.sourceId)
      identifier(duplicate.externalId)
      const target = this.db
        .prepare(
          'SELECT listings.data FROM listings JOIN offer_keys ON listings.id=offer_keys.listing_id WHERE offer_keys.source_id=? AND offer_keys.external_id=? AND transaction_type=?',
        )
        .get(
          duplicate.sourceId,
          duplicate.externalId,
          candidate.transactionType,
        )
      if (
        !target ||
        (prior &&
          JSON.parse(String(prior.data)).id !==
            JSON.parse(String(target.data)).id)
      )
        invalid('Unresolved or conflicting confirmed duplicate')
      prior = target
    }
    const previous: ListingProjection | undefined = prior
      ? JSON.parse(String(prior.data))
      : undefined
    const savedObservation = this.db
      .prepare(
        'SELECT data FROM offer_observations WHERE source_id=? AND external_id=? AND transaction_type=?',
      )
      .get(
        observation.identity.sourceId,
        observation.identity.externalId,
        candidate.transactionType,
      )
    const saved: SourceObservation | undefined = savedObservation
      ? JSON.parse(String(savedObservation.data))
      : undefined
    const removalEvidence = (key: keyof NormalizedFields) =>
      typeof observation.provenance[key] === 'string' &&
      observation.provenance[key].trim().length > 0
    for (const key of fieldNames) {
      const field = fields[key]
      if (typeof field === 'string' && !field.trim())
        invalid('Invalid blank source text')
      // Null is a removal only when the adapter supplies field-specific evidence.
      if (previous && fields[key] === null && !removalEvidence(key))
        delete fields[key]
    }
    if (previous && fields.availability === 'unknown')
      delete fields.availability
    if (
      previous &&
      fields.location?.kind === 'unknown' &&
      !removalEvidence('location')
    )
      delete fields.location
    if (
      fields.transactionType !== undefined &&
      fields.transactionType !== candidate.transactionType
    )
      invalid('Source offer transaction identity changed')
    const source = {
      sourceId: observation.identity.sourceId,
      externalId: observation.identity.externalId,
      name: 'Sample source',
      url: observation.url,
    }
    const listing: ListingProjection = listingProjection({
      id: previous?.id ?? randomUUID(),
      titleJa: '',
      sourceRefs: [source],
      primarySourceUrl: observation.url,
      transactionType: candidate.transactionType,
      salePriceJpy: null,
      rentMonthlyJpy: null,
      priceNoteJa: null,
      propertyType: null,
      floorAreaM2: null,
      landAreaM2: null,
      prefecture: null,
      municipalityId: null,
      municipalityNameJa: null,
      availability: 'unknown',
      location: { kind: 'unknown' },
      firstSeenAt: observation.sourceCheckedAt,
      lastSeenAt: observation.sourceCheckedAt,
      sourceCheckedAt: observation.sourceCheckedAt,
      ...(previous?.sourceRefs.some(
        (ref) =>
          ref.sourceId === source.sourceId &&
          ref.externalId === source.externalId,
      )
        ? previous
        : previous && { id: previous.id, firstSeenAt: previous.firstSeenAt }),
      ...saved?.fields,
      ...fields,
    })
    listing.lastSeenAt = observation.sourceCheckedAt
    listing.sourceCheckedAt = observation.sourceCheckedAt
    if (
      !listing.titleJa ||
      !['sale', 'rent', 'both', 'unknown'].includes(listing.transactionType) ||
      !['available', 'under_offer', 'unavailable', 'unknown'].includes(
        listing.availability,
      )
    )
      invalid('Invalid normalized listing')
    const businessFields = (value: ListingProjection) =>
      JSON.stringify(fieldNames.map((key) => value[key]))
    this.db
      .prepare(
        'INSERT INTO offer_observations VALUES (?,?,?,?) ON CONFLICT(source_id,external_id,transaction_type) DO UPDATE SET data=excluded.data',
      )
      .run(
        source.sourceId,
        source.externalId,
        candidate.transactionType,
        JSON.stringify({
          ...observation,
          freshnessScope: this.detailScope(adapter),
          ...(saved?.confirmedDuplicateOf && !duplicate
            ? { confirmedDuplicateOf: saved.confirmedDuplicateOf }
            : {}),
          contentHash: createHash('sha256')
            .update(businessFields(listing))
            .digest('hex'),
          fields: Object.fromEntries(
            fieldNames.map((key) => [key, listing[key]]),
          ),
        }),
      )
    this.db
      .prepare(
        'INSERT INTO offer_observation_history(source_id,external_id,transaction_type,data) SELECT source_id,external_id,transaction_type,data FROM offer_observations WHERE source_id=? AND external_id=? AND transaction_type=?',
      )
      .run(source.sourceId, source.externalId, candidate.transactionType)
    if (previous) {
      const isPrimary =
        previous.sourceRefs[0].sourceId === source.sourceId &&
        previous.sourceRefs[0].externalId === source.externalId
      if (!isPrimary)
        for (const key of fieldNames)
          Object.assign(listing, { [key]: previous[key] })
      listing.sourceRefs = previous.sourceRefs.some(
        (ref) =>
          ref.sourceId === source.sourceId &&
          ref.externalId === source.externalId,
      )
        ? previous.sourceRefs
        : [...previous.sourceRefs, source]
      listing.primarySourceUrl = previous.primarySourceUrl
      const evidence = listing.sourceRefs.map((ref) => {
        const row = this.db
          .prepare(
            'SELECT data FROM offer_observations WHERE source_id=? AND external_id=? AND transaction_type=?',
          )
          .get(ref.sourceId, ref.externalId, candidate.transactionType)
        return row
          ? (JSON.parse(String(row.data)) as SourceObservation)
          : undefined
      })
      const supporting = evidence.filter(
        (entry) => entry?.fields.availability !== 'unavailable',
      )
      const availability = supporting.map((entry) => entry?.fields.availability)
      listing.availability = !supporting.length
        ? 'unavailable'
        : availability.includes('available')
          ? 'available'
          : availability.includes('under_offer')
            ? 'under_offer'
            : 'unknown'
      // Primary business facts remain displayed even after its source withdraws.
      const times = evidence.map((entry) => entry?.sourceCheckedAt ?? null)
      listing.sourceCheckedAt = times.includes(null)
        ? null
        : times.reduce<string | null>(
            (earliest, time) =>
              earliest === null ||
              (time !== null && Date.parse(time) < Date.parse(earliest))
                ? time
                : earliest,
            null,
          )
      listing.lastSeenAt = listing.sourceCheckedAt
    }
    this.db
      .prepare(
        'INSERT INTO listings VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(
        listing.id,
        source.sourceId,
        previous
          ? String(
              this.db
                .prepare('SELECT external_id FROM listings WHERE id=?')
                .get(previous.id)!.external_id,
            )
          : listing.id,
        JSON.stringify({ ...previous, ...listing }),
      )
    this.db
      .prepare('INSERT OR IGNORE INTO offer_keys VALUES (?,?,?,?)')
      .run(
        source.sourceId,
        source.externalId,
        candidate.transactionType,
        listing.id,
      )
    this.db
      .prepare('INSERT OR IGNORE INTO listing_discovery_areas VALUES (?,?)')
      .run(listing.id, JSON.stringify(job.area))
    const unchanged =
      previous &&
      businessFields(previous) === businessFields(listing) &&
      JSON.stringify(previous.sourceRefs) === JSON.stringify(listing.sourceRefs)
    if (!previous) job.counts.added++
    else if (unchanged) job.counts.unchanged++
    else job.counts.updated++
  }
  private prepareRefresh(job: ImportJob, progress: Progress) {
    if (!progress.savedBySource) {
      // Recover older jobs from their retained source successes before counting
      // new commits across both detail classes.
      progress.savedBySource = { ...progress.refreshSaved }
      for (const row of this.db
        .prepare('SELECT data FROM source_traversals WHERE job_id=?')
        .all(job.id)) {
        const saved: Progress = JSON.parse(String(row.data))
        progress.savedBySource[saved.sourceIndex] = Math.max(
          progress.savedBySource[saved.sourceIndex] ?? 0,
          saved.sourceSaved ?? 0,
        )
      }
      if (progress.sourceIndex < this.adapters.length)
        progress.savedBySource[progress.sourceIndex] = Math.max(
          progress.savedBySource[progress.sourceIndex] ?? 0,
          progress.sourceSaved ?? 0,
        )
    }
    progress.detailClassUsed ??= { new: 0, refresh: 0 }
    progress.refreshReservation ??= this.refreshReservation
    progress.refreshIndex ??= 0
    if (progress.refresh) return
    const relevant = new Set(
      this.results({ area: job.area, showUnavailable: true }).listings.map(
        (listing) => listing.id,
      ),
    )
    progress.refresh = job.sources
      .flatMap((source, sourceIndex) => {
        const adapter = this.adapters.find(
          (adapter) => adapter.capabilities.sourceId === source.sourceId,
        )!
        return adapter.capabilities.geography === 'unsupported'
          ? []
          : this.db
              .prepare(
                `SELECT k.external_id,k.transaction_type,l.data,o.data AS observation
      FROM offer_keys k JOIN listings l ON l.id=k.listing_id
      LEFT JOIN offer_observations o ON o.source_id=k.source_id AND o.external_id=k.external_id AND o.transaction_type=k.transaction_type
      WHERE k.source_id=?`,
              )
              .all(adapter.capabilities.sourceId)
              .filter((row) => relevant.has(JSON.parse(String(row.data)).id))
              .map((row) => {
                const listing: ListingProjection = JSON.parse(String(row.data))
                const ref = listing.sourceRefs.find(
                  (ref) =>
                    ref.sourceId === adapter.capabilities.sourceId &&
                    ref.externalId === row.external_id,
                )!
                return {
                  sourceIndex,
                  checkedAt: row.observation
                    ? (JSON.parse(String(row.observation)) as SourceObservation)
                        .sourceCheckedAt
                    : null,
                  candidate: {
                    externalId: String(row.external_id),
                    transactionType: listing.transactionType,
                    url: ref.url,
                    location: listing.location,
                    municipalityId: listing.municipalityId,
                    publishedAt: null,
                    modifiedAt: null,
                    relevance: 'plausible' as const,
                  },
                }
              })
      })
      .sort(
        (a, b) =>
          (a.checkedAt === null ? -Infinity : Date.parse(a.checkedAt)) -
            (b.checkedAt === null ? -Infinity : Date.parse(b.checkedAt)) ||
          a.sourceIndex - b.sourceIndex ||
          a.candidate.externalId.localeCompare(b.candidate.externalId),
      )
    progress.reusedRefresh = progress.refresh.filter((task) => {
      const adapter = this.adapters.find(
        (adapter) =>
          adapter.capabilities.sourceId ===
          job.sources[task.sourceIndex].sourceId,
      )!
      return this.freshObservation(adapter, task.candidate)
    })
    progress.refresh = progress.refresh.filter(
      (task) => !progress.reusedRefresh!.includes(task),
    )
  }
  private freshObservation(adapter: SourceAdapter, candidate: Candidate) {
    const saved = this.db
      .prepare(
        'SELECT data FROM offer_observations WHERE source_id=? AND external_id=? AND transaction_type=?',
      )
      .get(
        adapter.capabilities.sourceId,
        candidate.externalId,
        candidate.transactionType,
      )
    const observation = saved ? JSON.parse(String(saved.data)) : undefined
    const freshUntil = observation
      ? Date.parse(observation.sourceCheckedAt) + this.detailFreshnessMs
      : 0
    return observation?.freshnessScope === this.detailScope(adapter) &&
      this.now() < freshUntil
      ? observation
      : undefined
  }
  private async detail(
    job: ImportJob,
    progress: Progress,
    sourceIndex: number,
    candidate: Candidate,
    detailClass: 'new' | 'refresh',
    advance: () => void,
  ) {
    const adapter = this.adapters.find(
      (adapter) =>
        adapter.capabilities.sourceId === job.sources[sourceIndex].sourceId,
    )!
    const source = job.sources[sourceIndex]
    const identity = JSON.stringify([
      adapter.capabilities.sourceId,
      candidate.externalId,
      candidate.transactionType,
    ])
    if (progress.completed.includes(identity)) {
      advance()
      this.saveProgress(job, progress)
      return
    }
    const observation = this.freshObservation(adapter, candidate)
    if (observation) {
      this.transaction(() => {
        this.ensure(job)
        const offer = this.db
          .prepare(
            'SELECT listing_id FROM offer_keys WHERE source_id=? AND external_id=? AND transaction_type=?',
          )
          .get(
            adapter.capabilities.sourceId,
            candidate.externalId,
            candidate.transactionType,
          )
        if (!offer) invalid('Successful detail has no saved listing')
        this.db
          .prepare('INSERT OR IGNORE INTO listing_discovery_areas VALUES (?,?)')
          .run(offer.listing_id!, JSON.stringify(job.area))
        progress.oldestDetailCheckAt = Math.min(
          progress.oldestDetailCheckAt ?? Infinity,
          Date.parse(observation.sourceCheckedAt),
        )
        if (sourceIndex === progress.sourceIndex)
          progress.sourceSaved = (progress.sourceSaved ?? 0) + 1
        progress.savedBySource![sourceIndex] =
          (progress.savedBySource![sourceIndex] ?? 0) + 1
        progress.completed.push(identity)
        advance()
        this.saveProgress(job, progress)
      })
      return
    }
    job.stage = 'fetching'
    this.save(job)
    const evidence = await this.parse(() =>
      adapter.fetchDetail(
        candidate,
        this.context(job, adapter, progress, detailClass),
      ),
    )
    this.ensure(job)
    const normalized = await this.parse(() => adapter.normalize(evidence))
    this.ensure(job)
    job.stage = 'saving'
    this.save(job)
    this.transaction(() => {
      this.ensure(job)
      job.counts.checked++
      if (normalized.kind === 'accepted') {
        try {
          this.commit(job, normalized.observation, adapter, candidate)
          progress.oldestDetailCheckAt = Math.min(
            progress.oldestDetailCheckAt ?? Infinity,
            Date.parse(normalized.observation.sourceCheckedAt),
          )
          if (sourceIndex === progress.sourceIndex)
            progress.sourceSaved = (progress.sourceSaved ?? 0) + 1
          progress.savedBySource![sourceIndex] =
            (progress.savedBySource![sourceIndex] ?? 0) + 1
        } catch (error) {
          if (
            !(error instanceof LocalApiError) ||
            error.code !== 'INVALID_REQUEST'
          )
            throw error
          job.counts.rejected++
          source.error = safeError(error)
        }
      } else {
        job.counts.rejected++
        source.error = {
          code: 'PARSE_ERROR',
          message: 'Source listing could not be parsed',
          retryable: false,
        }
      }
      progress.completed.push(identity)
      advance()
      progress.nextDetailClass = detailClass === 'refresh' ? 'new' : 'refresh'
      this.saveProgress(job, progress)
    })
  }
  private async refresh(job: ImportJob, progress: Progress, limit: number) {
    progress.refreshAttemptLimit = limit
    while (progress.refreshIndex! < progress.refresh!.length) {
      const task = progress.refresh![progress.refreshIndex!]
      const adapter = this.adapters.find(
        (adapter) =>
          adapter.capabilities.sourceId ===
          job.sources[task.sourceIndex].sourceId,
      )!
      if (
        job.budget.detailUsed >= limit &&
        !this.freshObservation(adapter, task.candidate)
      )
        break
      try {
        await this.detail(
          job,
          progress,
          task.sourceIndex,
          task.candidate,
          'refresh',
          () => {
            progress.refreshIndex!++
          },
        )
      } catch (error) {
        this.ensure(job)
        Object.assign(job, this.inspect(job.id))
        Object.assign(
          progress,
          JSON.parse(
            String(
              this.db
                .prepare('SELECT progress FROM import_jobs_v2 WHERE id=?')
                .get(job.id)!.progress,
            ),
          ),
        )
        if (error instanceof LocalApiError && error.code === 'BUDGET_EXHAUSTED')
          break
        job.sources[task.sourceIndex].error = safeError(error)
        progress.deferredRefresh ??= []
        progress.deferredRefresh.push(task)
        progress.refreshIndex!++
        this.saveProgress(job, progress)
      }
    }
    this.saveProgress(job, progress)
  }
  private upgradeProgress(job: ImportJob, progress: Progress, adapters: SourceAdapter[]) {
    // Old progress keys omitted transaction type. Resolve committed offers from
    // their migrated keys, so a repeated candidate after restart stays checked
    // without suppressing a distinct sale/rental variant.
    for (const kind of ['discovered', 'completed'] as const) {
      progress[kind] = [
        ...new Set(
          progress[kind].flatMap((identity) => {
            if (identity.startsWith('[')) return [identity]
            const matches: string[] = []
            for (const adapter of adapters) {
              const sourceId = adapter.capabilities.sourceId
              if (!identity.startsWith(`${sourceId}:`)) continue
              const externalId = identity.slice(sourceId.length + 1)
              const rows = this.db
                .prepare(
                  'SELECT transaction_type FROM offer_keys WHERE source_id=? AND external_id=?',
                )
                .all(sourceId, externalId)
              for (const row of rows)
                matches.push(
                  JSON.stringify([sourceId, externalId, row.transaction_type]),
                )
              if (kind === 'discovered')
                for (const candidate of progress.candidates) {
                  if (
                    candidate.externalId === externalId &&
                    sourceId === job.sources[progress.sourceIndex]?.sourceId
                  )
                    matches.push(
                      JSON.stringify([
                        sourceId,
                        externalId,
                        candidate.transactionType,
                      ]),
                    )
                }
            }
            return matches.length ? matches : [identity]
          }),
        ),
      ]
    }
    if (progress.oldestDetailCheckAt === undefined) {
      for (const identity of progress.completed) {
        if (!identity.startsWith('[')) continue
        const [sourceId, externalId, transactionType] = JSON.parse(identity)
        const row = this.db
          .prepare(
            'SELECT data FROM offer_observations WHERE source_id=? AND external_id=? AND transaction_type=?',
          )
          .get(sourceId, externalId, transactionType)
        if (!row) continue
        const observation: SourceObservation = JSON.parse(String(row.data))
        progress.oldestDetailCheckAt = Math.min(
          progress.oldestDetailCheckAt ?? Infinity,
          Date.parse(observation.sourceCheckedAt),
        )
      }
    }
    // Completed also includes rejections. Recover useful work only from this
    // source's retained successful checks during the interrupted execution.
    if (progress.sourceSaved === undefined) {
      const sourceId = job.sources[progress.sourceIndex]?.sourceId
      progress.sourceSaved = progress.completed.filter((identity) => {
        if (!identity.startsWith('[')) return false
        const [completedSource, externalId, transactionType] =
          JSON.parse(identity)
        if (completedSource !== sourceId) return false
        const row = this.db
          .prepare(
            'SELECT listings.data FROM listings JOIN offer_keys ON listings.id=offer_keys.listing_id WHERE offer_keys.source_id=? AND offer_keys.external_id=? AND offer_keys.transaction_type=?',
          )
          .get(sourceId, externalId, transactionType)
        if (!row || !job.startedAt) return false
        const listing: ListingProjection = JSON.parse(String(row.data))
        return (
          listing.sourceCheckedAt !== null &&
          Date.parse(listing.sourceCheckedAt) >= Date.parse(job.startedAt)
        )
      }).length
    }
  }
  private async parse<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (
        error instanceof LocalApiError ||
        this.controller?.signal.aborted ||
        this.stopping
      )
        throw error
      throw new LocalApiError(
        400,
        'PARSE_ERROR',
        'Source response could not be parsed',
      )
    }
  }
  private async run() {
    if (this.stopping || this.executing) return
    const job = this.claim()
    if (!job) {
      // Poll slowly for work submitted by another process or an expired lease.
      // Local submissions interrupt this timer and wake execution promptly.
      this.schedule(1000)
      return
    }
    this.executing = true
    this.executingJobId = job.id
    this.controller = new AbortController()
    this.heartbeat = setInterval(
      () => {
        if (this.owned())
          this.db
            .prepare('UPDATE executor_v2 SET expires=? WHERE owner=?')
            .run(this.now() + this.leaseMs, this.owner)
        else this.controller?.abort()
      },
      Math.max(10, this.leaseMs / 3),
    )
    try {
      const row = this.db
        .prepare('SELECT scope,progress FROM import_jobs_v2 WHERE id=?')
        .get(job.id)!
      const frozen = JSON.parse(String(row.scope))
      const adapters: SourceAdapter[] = frozen.sources.map(
        (source: { sourceId: string }) =>
          this.adapters.find(
            (adapter) => adapter.capabilities.sourceId === source.sourceId,
          ),
      )
      if (
        adapters.some((adapter) => !adapter) ||
        JSON.stringify(frozen.sources) !==
          JSON.stringify(adapters.map((adapter) => adapter.capabilities))
      )
        throw new LocalApiError(
          409,
          'CONFIGURATION_ERROR',
          'Saved source configuration is unavailable',
        )
      const reused = this.covering(job.area, true, job.id)
      if (
        reused &&
        job.budget.discoveryUsed === 0 &&
        job.budget.detailUsed === 0
      ) {
        this.transaction(() => {
          this.ensure(job)
          job.state = 'succeeded'
          job.stage = 'finished'
          job.finishedAt = this.time()
          job.coverage = reused.coverage
          job.sources = reused.sources
          job.reasons = ['CACHE_REUSED']
          for (const row of this.db
            .prepare(
              "SELECT data FROM import_requests_v2 WHERE job_id=? AND json_extract(data,'$.state') IN ('queued','running')",
            )
            .all(job.id)) {
            const request: ImportRequest = JSON.parse(String(row.data))
            request.state = 'succeeded'
            request.finishedAt = job.finishedAt
            request.error = null
            request.disposition = 'cached'
            request.jobIds = [reused.id]
            this.db
              .prepare(
                'UPDATE import_requests_v2 SET job_id=?,data=? WHERE id=?',
              )
              .run(reused.id, JSON.stringify(request), request.id)
          }
          this.save(job)
        })
        return
      }
      const progress: Progress = JSON.parse(String(row.progress))
      this.upgradeProgress(job, progress, adapters)
      if (!job.continuation.fromJobId)
        job.counts.discovered = progress.discovered.length
      this.prepareRefresh(job, progress)
      // Retain the upgrade before outbound work: a later failed transaction
      // restores this durable progress rather than discarding recovered evidence.
      this.transaction(() => {
        this.ensure(job)
        this.saveProgress(job, progress)
      })
      const reservation =
        job.budget.detailLimit < 2
          ? progress.nextDetailClass === 'new'
            ? 0
            : 1
          : Math.max(
              1,
              Math.min(
                job.budget.detailLimit - 1,
                Math.floor(
                  job.budget.detailLimit * progress.refreshReservation!,
                ),
              ),
            )
      await this.refresh(job, progress, reservation)
      for (; progress.sourceIndex < adapters.length;) {
        const adapter = adapters[progress.sourceIndex]
        const source = job.sources[progress.sourceIndex]
        if (job.continuation.fromJobId && source.state === 'succeeded') {
          progress.sourceIndex++
          this.saveProgress(job, progress)
          continue
        }
        const resume = progress.resumeSources?.[source.sourceId]
        if (resume) {
          delete progress.resumeSources![source.sourceId]
          if (resume.limitation) {
            resume.cursor = null
            resume.exhausted = false
            resume.limitation = null
            resume.visitedCursors = []
            job.continuation.restarted = true
            job.continuation.restartReason = 'SOURCE_LIMITATION'
          }
          Object.assign(progress, {
            ...resume,
            resumeSources: progress.resumeSources,
          })
          this.saveProgress(job, progress)
        }
        progress.sourceSaved = Math.max(progress.sourceSaved ?? 0, progress.savedBySource?.[progress.sourceIndex] ?? 0)
        source.state = 'running'
        const context = this.context(job, adapter, progress)
        try {
          if (adapter.capabilities.geography === 'unsupported')
            throw new LocalApiError(
              409,
              'CONFIGURATION_ERROR',
              'Source does not support this search geography',
            )
          while (true) {
            this.ensure(job)
            if (!progress.candidates.length && !progress.exhausted) {
              job.stage = 'discovering'
              this.save(job)
              progress.visitedCursors ??= []
              const cursorKey = progress.cursor ?? '<start>'
              if (progress.visitedCursors.includes(cursorKey))
                throw new LocalApiError(
                  400,
                  'PARSE_ERROR',
                  'Discovery repeated a cursor',
                )
              const page = await this.parse(() =>
                adapter.discover(
                  {
                    area: job.area,
                    queryKey: job.scopeKey,
                    cursor: progress.cursor,
                  },
                  context,
                ),
              ).catch((error) => {
                if (
                  progress.cursor !== null &&
                  error instanceof LocalApiError &&
                  ['CURSOR_EXPIRED', 'CURSOR_INVALID'].includes(error.code)
                ) {
                  progress.cursor = null
                  progress.visitedCursors = []
                  progress.exhausted = false
                  progress.limitation = null
                  job.continuation.restarted = true
                  job.continuation.restartReason = error.code
                  job.reasons.push(error.code)
                  job.coverage.caveats.push(
                    'Saved cursor expired or invalid; discovery restarted within this job budget',
                  )
                  this.transaction(() => {
                    this.ensure(job)
                    this.saveProgress(job, progress)
                  })
                  return null
                }
                throw error
              })
              if (page === null) continue
              this.ensure(job)
              if (
                !page ||
                !Array.isArray(page.candidates) ||
                typeof page.exhausted !== 'boolean' ||
                (page.nextCursor !== null &&
                  typeof page.nextCursor !== 'string') ||
                (page.limitation !== null &&
                  typeof page.limitation !== 'string') ||
                page.candidates.some(
                  (candidate) =>
                    !candidate ||
                    typeof candidate.externalId !== 'string' ||
                    typeof candidate.url !== 'string' ||
                    !['known_inside', 'plausible', 'known_outside'].includes(
                      candidate.relevance,
                    ),
                )
              )
                throw new LocalApiError(
                  400,
                  'PARSE_ERROR',
                  'Source discovery could not be parsed',
                )
              progress.visitedCursors.push(cursorKey)
              progress.candidates = page.candidates
              progress.candidateIndex = 0
              progress.cursor = page.nextCursor
              progress.exhausted = page.exhausted
              progress.limitation = page.limitation
              for (const candidate of page.candidates) {
                const identity = JSON.stringify([
                  adapter.capabilities.sourceId,
                  candidate.externalId,
                  candidate.transactionType,
                ])
                if (!progress.discovered.includes(identity)) {
                  progress.discovered.push(identity)
                  job.counts.discovered++
                }
              }
              this.transaction(() => this.saveProgress(job, progress))
            }
            for (; progress.candidateIndex < progress.candidates.length;) {
              this.ensure(job)
              const candidate = progress.candidates[progress.candidateIndex]
              const identity = JSON.stringify([
                adapter.capabilities.sourceId,
                candidate.externalId,
                candidate.transactionType,
              ])
              if (
                candidate.relevance === 'known_outside' ||
                (candidate.location?.kind === 'verified' &&
                  !locationMatchesArea(candidate.location, job.area)) ||
                progress.completed.includes(identity)
              ) {
                progress.candidateIndex++
                this.saveProgress(job, progress)
                continue
              }
              const known = this.db
                .prepare(
                  'SELECT listing_id FROM offer_keys WHERE source_id=? AND external_id=? AND transaction_type=?',
                )
                .get(
                  adapter.capabilities.sourceId,
                  candidate.externalId,
                  candidate.transactionType,
                )
              if (
                known &&
                !this.freshObservation(adapter, candidate) &&
                !progress.refresh!.some(
                  (task) =>
                    task.sourceIndex === progress.sourceIndex &&
                    task.candidate.externalId === candidate.externalId &&
                    task.candidate.transactionType ===
                      candidate.transactionType,
                )
              )
                progress.refresh!.push({
                  sourceIndex: progress.sourceIndex,
                  candidate,
                  checkedAt: null,
                })
              const refreshTask = progress.refresh!.some(
                (task) =>
                  task.sourceIndex === progress.sourceIndex &&
                  task.candidate.externalId === candidate.externalId &&
                  task.candidate.transactionType === candidate.transactionType,
              )
              if (refreshTask) {
                progress.candidateIndex++
                this.saveProgress(job, progress)
                continue
              }
              await this.detail(
                job,
                progress,
                progress.sourceIndex,
                candidate,
                known ? 'refresh' : 'new',
                () => {
                  progress.candidateIndex++
                },
              )
            }
            progress.candidates = []
            progress.candidateIndex = 0
            this.saveProgress(job, progress)
            if (progress.exhausted || progress.limitation) break
            if (!progress.cursor)
              throw new LocalApiError(
                400,
                'PARSE_ERROR',
                'Discovery did not provide continuation',
              )
          }
          source.state =
            source.error || progress.limitation
              ? usefulProgress(progress, source.error?.code)
                ? 'partial'
                : 'failed'
              : 'succeeded'
          source.coverage =
            progress.exhausted && !progress.limitation && !source.error
              ? 'complete'
              : 'partial'
          if (progress.limitation) {
            job.reasons.push('SOURCE_LIMITATION')
            job.coverage.caveats.push(progress.limitation)
          }
          if (adapter.capabilities.geography === 'municipality')
            job.coverage.caveats.push(
              'Municipality source coverage may extend beyond the requested circle.',
            )
        } catch (error) {
          this.ensure(job)
          Object.assign(job, this.inspect(job.id))
          Object.assign(
            progress,
            JSON.parse(
              String(
                this.db
                  .prepare('SELECT progress FROM import_jobs_v2 WHERE id=?')
                  .get(job.id)!.progress,
              ),
            ),
          )
          const failedSource = job.sources[progress.sourceIndex]
          failedSource.error = safeError(error)
          job.coverage.caveats.push(
            `${adapter.capabilities.sourceId}: ${failedSource.error.message}`,
          )
          failedSource.state = usefulProgress(progress, failedSource.error.code)
            ? 'partial'
            : 'failed'
          failedSource.coverage = 'partial'
          job.reasons.push(failedSource.error.code)
        }
        // Retain the interrupted task privately; #6 can consume it without
        // equating this terminal source outcome with completed discovery.
        this.db
          .prepare('INSERT OR REPLACE INTO source_traversals VALUES (?,?,?)')
          .run(
            job.id,
            adapter.capabilities.sourceId,
            JSON.stringify({
              ...progress,
              capabilities: adapter.capabilities,
              area: job.area,
              scopeKey: job.scopeKey,
              outcome: job.sources[progress.sourceIndex],
            }),
          )
        progress.sourceSaved = 0
        progress.sourceIndex++
        progress.candidates = []
        progress.candidateIndex = 0
        progress.visitedCursors = []
        progress.cursor = null
        progress.exhausted = false
        progress.limitation = null
        this.saveProgress(job, progress)
      }
      // Discovery/new work releases its unused capacity to the oldest deferred refreshes.
      await this.refresh(job, progress, job.budget.detailLimit)
      for (const task of progress.reusedRefresh ?? []) {
        const sourceId = job.sources[task.sourceIndex].sourceId
        const row = this.db
          .prepare(
            'SELECT data FROM offer_observations WHERE source_id=? AND external_id=? AND transaction_type=?',
          )
          .get(
            sourceId,
            task.candidate.externalId,
            task.candidate.transactionType,
          )
        if (row)
          progress.oldestDetailCheckAt = Math.min(
            progress.oldestDetailCheckAt ?? Infinity,
            Date.parse(JSON.parse(String(row.data)).sourceCheckedAt),
          )
      }
      progress.refresh!.push(...(progress.deferredRefresh ?? []))
      progress.deferredRefresh = []
      this.saveProgress(job, progress)
      for (const task of progress.refresh!.slice(progress.refreshIndex)) {
        const source = job.sources[task.sourceIndex]
        if (
          source.state !== 'failed' ||
          !source.error ||
          source.error.code === 'BUDGET_EXHAUSTED' ||
          (progress.savedBySource?.[task.sourceIndex] ?? 0) > 0
        )
          source.state = 'partial'
        source.coverage = 'partial'
        source.error ??= {
          code: 'BUDGET_EXHAUSTED',
          message: 'Deferred refresh work remains',
          retryable: false,
        }
        if (!job.reasons.includes(source.error.code))
          job.reasons.push(source.error.code)
      }
      for (const [sourceIndex, source] of job.sources.entries()) {
        if (source.error && !job.reasons.includes(source.error.code))
          job.reasons.push(source.error.code)
        if (source.error && source.state === 'succeeded') {
          source.state =
            (progress.savedBySource?.[sourceIndex] ?? 0) > 0
              ? 'partial'
              : 'failed'
          source.coverage = 'partial'
        }
      }
      for (const row of this.db
        .prepare('SELECT source_id,data FROM source_traversals WHERE job_id=?')
        .all(job.id)) {
        const saved = JSON.parse(String(row.data))
        for (const key of [
          'refresh',
          'reusedRefresh',
          'refreshIndex',
          'refreshSaved',
          'savedBySource',
          'deferredRefresh',
          'detailClassUsed',
          'nextDetailClass',
          'refreshReservation',
        ] as const)
          saved[key] = progress[key]
        saved.outcome = job.sources.find(
          (source) => source.sourceId === row.source_id,
        )
        this.db
          .prepare(
            'UPDATE source_traversals SET data=? WHERE job_id=? AND source_id=?',
          )
          .run(JSON.stringify(saved), job.id, row.source_id)
      }
      this.ensure(job)
      job.state = job.sources.every((source) => source.state === 'succeeded')
        ? 'succeeded'
        : job.sources.some(
              (source) =>
                source.state === 'succeeded' || source.state === 'partial',
            )
          ? 'partial'
          : 'failed'
      job.error = job.sources.find((source) => source.error)?.error ?? null
      job.coverage.status = job.sources.every(
        (source) => source.coverage === 'complete',
      )
        ? 'complete'
        : 'partial'
      if (job.state === 'succeeded') {
        job.coverage.lastSuccessfulCheckAt = this.time()
        job.coverage.freshUntil = new Date(
          Math.min(
            this.now() + this.areaFreshnessMs,
            progress.oldestDetailCheckAt === undefined
              ? Infinity
              : progress.oldestDetailCheckAt + this.detailFreshnessMs,
          ),
        ).toISOString()
      }
      if (job.state !== 'succeeded')
        job.coverage.caveats.push(
          'Required import work is incomplete; saved results retained.',
        )
      job.coverage.caveats = [...new Set(job.coverage.caveats)]
      job.stage = 'finished'
      job.finishedAt = this.time()
      this.transaction(() => {
        this.ensure(job)
        this.save(job)
      })
    } catch (error) {
      if (this.owned()) {
        const current = this.inspect(job.id)
        // A failed transaction must not later publish its rolled-back counters.
        Object.assign(job, current)
        if (current.cancelRequestedAt) {
          job.cancelRequestedAt = current.cancelRequestedAt
          job.state = 'cancelled'
        } else if (this.stopping) return
        else {
          job.state =
            job.counts.added + job.counts.updated + job.counts.unchanged > 0
              ? 'partial'
              : 'failed'
          job.error = safeError(error)
        }
        job.stage = 'finished'
        job.finishedAt = this.time()
        job.sources.forEach((source) => {
          if (source.state === 'running' || source.state === 'queued') {
            source.state = job.state
            source.error = job.error
          }
        })
        this.transaction(() => {
          if (this.owned()) this.save(job)
        })
      }
    } finally {
      this.controller?.abort()
      await this.transportQueue.tail
      clearInterval(this.heartbeat)
      this.db.prepare('DELETE FROM executor_v2 WHERE owner=?').run(this.owner)
      this.executing = false
      this.executingJobId = undefined
      if (this.stopping) this.finishClose()
      else this.schedule()
    }
  }
  private finishClose() {
    if (!this.closed) {
      this.db.close()
      this.closed = true
    }
  }
  async close() {
    if (this.closed) return
    this.stopping = true
    clearTimeout(this.timer)
    this.controller?.abort()
    while (this.executing)
      await new Promise((resolve) => setTimeout(resolve, 5))
    this.finishClose()
  }
  async dispatch(operation: Operation, input: unknown): Promise<unknown> {
    switch (operation) {
      case 'createImportRequest':
        return this.createRequest(input)
      case 'inspectImportRequest':
        return this.inspectRequest(input)
      case 'inspectImport':
        return this.inspect(input)
      case 'cancelImport':
        return this.cancel(input)
      case 'cancelImportRequest':
        return this.cancelRequest(input)
      case 'listImports':
        return this.list(input)
      case 'areaResults':
        return this.results(input)
      case 'shutdown':
        if (input !== undefined) invalid()
        await this.close()
        return null
      default:
        invalid('Unknown operation')
    }
  }
}
