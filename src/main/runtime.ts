import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { distanceMetres, isSelectedArea } from '../shared/geography'
import type {
  AreaResults,
  ListingProjection,
  SelectedArea,
} from '../shared/listings'
import type { Job, Operation } from '../shared/desktop'
import { fixtures } from './fixtures'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function validateId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200)
    throw new Error('Invalid identifier')
  return value
}

// Only the utility process owns this connection. Transactions include both effects
// and progress so recovery cannot replay a committed offer as a new addition.
export class ImportRuntime {
  private db: DatabaseSync
  private executing = false
  private stopping = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    path: string,
    private delayMs = 300,
  ) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES (1);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_keys (
        key TEXT PRIMARY KEY, scope TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
        data TEXT NOT NULL, UNIQUE(source_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        source_id TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(source_id, external_id)
      );
    `)
    for (const job of this.list().filter((j) => j.state === 'running')) {
      this.save({ ...job, state: 'queued', stage: 'queued' })
    }
    this.schedule()
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
  private save(job: Job) {
    this.db
      .prepare('UPDATE jobs SET state = ?, data = ? WHERE id = ?')
      .run(job.state, JSON.stringify(job), job.id)
  }
  list(): Job[] {
    return this.db
      .prepare('SELECT data FROM jobs ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r.data)))
  }
  inspect(input: unknown): Job {
    const row = this.db
      .prepare('SELECT data FROM jobs WHERE id = ?')
      .get(validateId(input))
    if (!row) throw new Error('Import not found')
    return JSON.parse(String(row.data))
  }
  create(input: unknown): Job {
    if (!record(input) || !isSelectedArea(input.area))
      throw new Error(
        'Invalid selected area: radius must be greater than 0 and at most 10 km',
      )
    const key = validateId(input.idempotencyKey)
    const area: SelectedArea = {
      center: {
        latitude: input.area.center.latitude,
        longitude: input.area.center.longitude,
      },
      radiusKm: input.area.radiusKm,
    }
    const scope = JSON.stringify(area)
    const job = this.transaction(() => {
      const previous = this.db
        .prepare('SELECT scope, data FROM jobs WHERE idempotency_key = ?')
        .get(key)
      if (previous) {
        if (previous.scope !== scope)
          throw new Error('Idempotency key already belongs to another area')
        return JSON.parse(String(previous.data)) as Job
      }
      const alias = this.db
        .prepare('SELECT scope, job_id FROM request_keys WHERE key = ?')
        .get(key)
      if (alias) {
        if (alias.scope !== scope)
          throw new Error('Idempotency key already belongs to another area')
        return this.inspect(alias.job_id)
      }
      const active = this.db
        .prepare(
          "SELECT data FROM jobs WHERE scope = ? AND state IN ('queued', 'running') ORDER BY rowid LIMIT 1",
        )
        .get(scope)
      // A durable key alias retains idempotency after the shared job finishes.
      if (active) {
        const shared: Job = JSON.parse(String(active.data))
        this.db
          .prepare('INSERT OR IGNORE INTO request_keys VALUES (?, ?, ?)')
          .run(key, scope, shared.id)
        return shared
      }
      const next: Job = {
        id: randomUUID(),
        area,
        state: 'queued',
        stage: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        added: 0,
        updated: 0,
        processed: 0,
        error: null,
      }
      this.db
        .prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?)')
        .run(next.id, key, scope, next.state, JSON.stringify(next))
      return next
    })
    this.schedule()
    return job
  }
  cancel(input: unknown): Job {
    const job = this.inspect(input)
    if (job.state === 'queued' || job.state === 'running') {
      job.state = 'cancelled'
      job.stage = 'finished'
      job.finishedAt = new Date().toISOString()
      this.save(job)
    }
    return job
  }
  results(input: unknown): AreaResults {
    if (
      !record(input) ||
      !isSelectedArea(input.area) ||
      typeof input.showUnavailable !== 'boolean'
    )
      throw new Error('Invalid area query')
    const { area, showUnavailable } = input
    const listings: ListingProjection[] = this.db
      .prepare('SELECT data FROM listings')
      .all()
      .map((r) => JSON.parse(String(r.data)))
    return {
      area,
      showUnavailable,
      mode: 'synthetic',
      listings: listings.filter(
        (l) =>
          (showUnavailable || l.availability !== 'unavailable') &&
          l.location.kind === 'verified' &&
          distanceMetres(area.center, l.location.point) <=
            area.radiusKm * 1000 + 1e-8,
      ),
      municipalityGroups: [],
      coverage: {
        status: 'unknown',
        lastSuccessfulCheckAt: null,
        freshUntil: null,
        scopeKey: null,
        caveats: [
          'Synthetic fixtures only; no real inventory or source coverage.',
        ],
      },
      generatedAt: new Date().toISOString(),
    }
  }
  private schedule() {
    if (this.stopping || this.executing || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, 0)
  }
  private async run() {
    if (this.stopping || this.executing) return
    const job = this.list().find((j) => j.state === 'queued')
    if (!job) return
    this.executing = true
    try {
      job.state = 'running'
      job.stage = 'discovering'
      job.startedAt ??= new Date().toISOString()
      this.save(job)
      const candidates = fixtures.filter(
        (l) =>
          l.location.kind === 'verified' &&
          distanceMetres(job.area.center, l.location.point) <=
            job.area.radiusKm * 1000 + 1e-8,
      )
      for (let index = job.processed; index < candidates.length; index++) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs))
        if (this.stopping || this.inspect(job.id).state === 'cancelled') return
        this.transaction(() => {
          const listing = structuredClone(candidates[index])
          const source = listing.sourceRefs[0]
          const exists = this.db
            .prepare(
              'SELECT id FROM listings WHERE source_id = ? AND external_id = ?',
            )
            .get(source.sourceId, source.externalId)
          const now = new Date().toISOString()
          const prior = this.db
            .prepare('SELECT data FROM listings WHERE id = ?')
            .get(listing.id)
          listing.firstSeenAt = prior
            ? JSON.parse(String(prior.data)).firstSeenAt
            : now
          listing.lastSeenAt = now
          listing.sourceCheckedAt = now
          this.db
            .prepare(
              'INSERT INTO observations VALUES (?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET data = excluded.data',
            )
            .run(source.sourceId, source.externalId, JSON.stringify(listing))
          this.db
            .prepare(
              'INSERT INTO listings VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
            )
            .run(
              listing.id,
              source.sourceId,
              source.externalId,
              JSON.stringify(listing),
            )
          if (exists) job.updated++
          else job.added++
          job.processed = index + 1
          job.stage = 'saving'
          this.save(job)
        })
      }
      if (!this.stopping && this.inspect(job.id).state !== 'cancelled') {
        job.state = 'succeeded'
        job.stage = 'finished'
        job.finishedAt = new Date().toISOString()
        this.save(job)
      }
    } catch {
      job.state = 'failed'
      job.stage = 'finished'
      job.error = 'Import failed. Saved listings are retained.'
      job.finishedAt = new Date().toISOString()
      this.save(job)
    } finally {
      this.executing = false
      if (this.stopping) this.db.close()
      else this.schedule()
    }
  }
  async close() {
    this.stopping = true
    clearTimeout(this.timer)
    if (!this.executing) this.db.close()
    else
      while (this.executing)
        await new Promise((resolve) => setTimeout(resolve, 10))
  }
  async dispatch(operation: Operation, input: unknown): Promise<unknown> {
    switch (operation) {
      case 'createImport':
        return this.create(input)
      case 'inspectImport':
        return this.inspect(input)
      case 'cancelImport':
        return this.cancel(input)
      case 'listImports':
        return this.list()
      case 'areaResults':
        return this.results(input)
      case 'shutdown':
        await this.close()
        return null
      default:
        throw new Error('Unknown operation')
    }
  }
}
