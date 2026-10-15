import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { distanceMetres, isSelectedArea } from '../shared/geography'
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
import { listingProjection } from './projection'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    invalid('Invalid identifier')
  return value
}
const active = (job: ImportJob) =>
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
  cursor: string | null
  candidates: Candidate[]
  candidateIndex: number
  exhausted: boolean
  limitation: string | null
  discovered: string[]
  completed: string[]
}
type RuntimeOptions = {
  adapters?: SourceAdapter[]
  now?: () => number
  leaseMs?: number
}

// Worker API seam: all SQLite access and execution ownership remain outside renderer.
export class ImportRuntime {
  private db: DatabaseSync
  private readonly owner = randomUUID()
  private readonly adapters: SourceAdapter[]
  private readonly now: () => number
  private readonly leaseMs: number
  private stopping = false
  private executing = false
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private controller: AbortController | undefined
  constructor(path: string, delayMs = 300, options: RuntimeOptions = {}) {
    this.adapters = options.adapters ?? [syntheticAdapter(delayMs)]
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? 30000
    this.db = new DatabaseSync(path)
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS import_jobs_v2 (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, scope TEXT NOT NULL, progress TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS import_requests_v2 (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, semantic TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES import_jobs_v2(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executor_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(source_id,external_id));
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
  private allJobs(): ImportJob[] {
    return this.db
      .prepare('SELECT data FROM import_jobs_v2 ORDER BY rowid')
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
    return { jobs: this.allJobs().filter(active) }
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
  private save(job: ImportJob) {
    this.db
      .prepare('UPDATE import_jobs_v2 SET state=?,data=? WHERE id=?')
      .run(job.state, JSON.stringify(job), job.id)
    const row = this.db
      .prepare('SELECT data FROM import_requests_v2 WHERE job_id=?')
      .get(job.id)
    if (row) {
      const request: ImportRequest = JSON.parse(String(row.data))
      request.state = job.state
      request.finishedAt = job.finishedAt
      request.error = job.error
      this.db
        .prepare('UPDATE import_requests_v2 SET data=? WHERE job_id=?')
        .run(JSON.stringify(request), job.id)
    }
  }
  createRequest(input: unknown): ImportRequest {
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
      const scope = JSON.stringify({
        area,
        sources: this.adapters.map((adapter) => adapter.capabilities),
        filters: { residential: true },
        referenceVersion: 'synthetic-v1',
      })
      const scopeKey = createHash('sha256').update(scope).digest('hex')
      const job: ImportJob = {
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
          discoveryLimit: 10,
          detailUsed: 0,
          detailLimit: 100,
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
      }
      const request: ImportRequest = {
        id: randomUUID(),
        area,
        intent: 'import',
        state: 'queued',
        disposition: 'created',
        jobIds: [job.id],
        pendingFollowUp: false,
        createdAt: job.createdAt,
        finishedAt: null,
        error: null,
      }
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
  cancel(input: unknown): ImportJob {
    const job = this.transaction(() => {
      const job = this.inspect(input)
      if (!active(job)) return job
      job.cancelRequestedAt ??= this.time()
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
    })
    if (job.state === 'running') this.controller?.abort()
    return job
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
      .map((row) => listingProjection(JSON.parse(String(row.data))))
    return {
      area,
      showUnavailable,
      mode: 'synthetic',
      listings: listings.filter(
        (listing) =>
          (showUnavailable || listing.availability !== 'unavailable') &&
          (listing.location.kind === 'verified' ||
            listing.location.kind === 'unverified') &&
          distanceMetres(area.center, listing.location.point) <=
            area.radiusKm * 1000 + 1e-8,
      ),
      municipalityGroups: [],
      coverage: coverage(null),
      generatedAt: this.time(),
    }
  }
  private schedule() {
    if (this.stopping || this.executing || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, 25)
  }
  private claim(): ImportJob | undefined {
    return this.transaction(() => {
      const lease = this.db
        .prepare('SELECT owner,expires FROM executor_v2 WHERE singleton=1')
        .get()
      if (
        lease &&
        lease.owner !== this.owner &&
        Number(lease.expires) > this.now()
      )
        return
      const job = this.allJobs().find(active)
      if (!job) return
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
  private context(job: ImportJob, adapter: SourceAdapter): AdapterContext {
    return {
      signal: this.controller!.signal,
      now: () => this.time(),
      request: async (kind, value) => {
        this.ensure(job)
        const url = new URL(value)
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          !adapter.capabilities.allowedHosts.includes(url.hostname)
        )
          throw new LocalApiError(
            400,
            'INVALID_SOURCE_URL',
            'Source URL rejected',
          )
        const used = kind === 'discovery' ? 'discoveryUsed' : 'detailUsed'
        const limit = kind === 'discovery' ? 'discoveryLimit' : 'detailLimit'
        if (job.budget[used] >= job.budget[limit])
          throw new LocalApiError(
            409,
            'BUDGET_EXHAUSTED',
            'Import request budget exhausted',
          )
        job.budget[used]++
        this.save(job)
        // The synthetic transport performs no network requests. Live transport is out of scope.
        return null
      },
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
      !Number.isFinite(Date.parse(observation.sourceCheckedAt))
    )
      invalid('Invalid source observation')
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
    const prior = this.db
      .prepare('SELECT data FROM listings WHERE source_id=? AND external_id=?')
      .get(observation.identity.sourceId, observation.identity.externalId)
    const previous: ListingProjection | undefined = prior
      ? JSON.parse(String(prior.data))
      : undefined
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
      transactionType: 'unknown',
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
      ...previous,
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
    const oldObservation = this.db
      .prepare(
        'SELECT data FROM observations WHERE source_id=? AND external_id=?',
      )
      .get(source.sourceId, source.externalId)
    const unchanged =
      oldObservation &&
      JSON.parse(String(oldObservation.data)).contentHash ===
        observation.contentHash
    this.db
      .prepare(
        'INSERT INTO observations VALUES (?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET data=excluded.data',
      )
      .run(source.sourceId, source.externalId, JSON.stringify(observation))
    this.db
      .prepare(
        'INSERT INTO listings VALUES (?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET data=excluded.data',
      )
      .run(
        listing.id,
        source.sourceId,
        source.externalId,
        JSON.stringify(listing),
      )
    if (!previous) job.counts.added++
    else if (unchanged) job.counts.unchanged++
    else job.counts.updated++
  }
  private async run() {
    if (this.stopping || this.executing) return
    const job = this.claim()
    if (!job) {
      this.schedule()
      return
    }
    this.executing = true
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
      if (
        JSON.stringify(frozen.sources) !==
        JSON.stringify(this.adapters.map((adapter) => adapter.capabilities))
      )
        throw new LocalApiError(
          409,
          'CONFIGURATION_ERROR',
          'Saved source configuration is unavailable',
        )
      const progress: Progress = JSON.parse(String(row.progress))
      for (
        ;
        progress.sourceIndex < this.adapters.length;
        progress.sourceIndex++
      ) {
        const adapter = this.adapters[progress.sourceIndex]
        const source = job.sources[progress.sourceIndex]
        source.state = 'running'
        const context = this.context(job, adapter)
        while (true) {
          this.ensure(job)
          if (!progress.candidates.length && !progress.exhausted) {
            job.stage = 'discovering'
            this.save(job)
            const page = await adapter.discover(
              {
                area: job.area,
                queryKey: job.scopeKey,
                cursor: progress.cursor,
              },
              context,
            )
            this.ensure(job)
            progress.candidates = page.candidates
            progress.candidateIndex = 0
            progress.cursor = page.nextCursor
            progress.exhausted = page.exhausted
            progress.limitation = page.limitation
            for (const candidate of page.candidates) {
              const identity = `${adapter.capabilities.sourceId}:${candidate.externalId}`
              if (!progress.discovered.includes(identity))
                progress.discovered.push(identity)
            }
            job.counts.discovered = progress.discovered.length
            this.transaction(() => this.saveProgress(job, progress))
          }
          for (; progress.candidateIndex < progress.candidates.length;) {
            this.ensure(job)
            const candidate = progress.candidates[progress.candidateIndex]
            const identity = `${adapter.capabilities.sourceId}:${candidate.externalId}`
            if (
              candidate.relevance === 'known_outside' ||
              progress.completed.includes(identity)
            ) {
              progress.candidateIndex++
              this.saveProgress(job, progress)
              continue
            }
            job.stage = 'fetching'
            this.save(job)
            const evidence = await adapter.fetchDetail(candidate, context)
            this.ensure(job)
            const normalized = adapter.normalize(evidence)
            job.stage = 'saving'
            this.save(job)
            this.transaction(() => {
              this.ensure(job)
              job.counts.checked++
              if (normalized.kind === 'accepted')
                this.commit(job, normalized.observation, adapter, candidate)
              else {
                job.counts.rejected++
                source.error = normalized.error
              }
              progress.completed.push(identity)
              progress.candidateIndex++
              this.saveProgress(job, progress)
            })
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
          source.error || progress.limitation ? 'partial' : 'succeeded'
        source.coverage =
          progress.exhausted && !progress.limitation ? 'complete' : 'partial'
        if (progress.limitation) job.reasons.push(progress.limitation)
        progress.cursor = null
        progress.exhausted = false
        progress.limitation = null
        this.saveProgress(job, progress)
      }
      this.ensure(job)
      job.state = job.sources.some((source) => source.state === 'partial')
        ? 'partial'
        : 'succeeded'
      job.coverage.status = job.sources.every(
        (source) => source.coverage === 'complete',
      )
        ? 'complete'
        : 'partial'
      if (job.state === 'succeeded')
        job.coverage.lastSuccessfulCheckAt = this.time()
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
      clearInterval(this.heartbeat)
      this.db.prepare('DELETE FROM executor_v2 WHERE owner=?').run(this.owner)
      this.executing = false
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
