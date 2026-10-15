import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { SelectedArea } from '../src/listings/contracts'
import type { ImportJob, ImportRequest, AdapterCapabilities } from './contracts'

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
export const coverage = () => ({
  status: 'unknown' as const,
  lastSuccessfulCheckAt: null,
  freshUntil: null,
  scopeKey: null,
  caveats: ['Synthetic fixtures only; no real inventory or source coverage.'],
})
export function requestProjection(
  row: { id: string; created_at: Date },
  job: ImportJob,
): ImportRequest {
  return {
    id: row.id,
    area: job.area,
    intent: 'import',
    state: job.state,
    disposition: 'created',
    jobIds: [job.id],
    pendingFollowUp: false,
    createdAt: row.created_at.toISOString(),
    finishedAt: job.finishedAt,
    error: job.error,
  }
}
export async function getJob(
  db: Pool | PoolClient,
  id: string,
): Promise<ImportJob> {
  const result = await db.query(
    'select document from import_runtime.jobs where id=$1',
    [id],
  )
  if (!result.rowCount) throw new ApiFailure(404, 'NOT_FOUND', 'Unknown job.')
  return result.rows[0].document
}
export async function createRequest(
  pool: Pool,
  area: SelectedArea,
  key: string,
  sources: AdapterCapabilities[],
  now: Date,
) {
  const db = await pool.connect()
  try {
    await db.query('begin')
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      key,
    ])
    const semanticInput = { area, intent: 'import' }
    const existing = await db.query(
      'select * from import_runtime.requests where idempotency_key=$1',
      [key],
    )
    if (existing.rowCount) {
      // jsonb semantic equality ignores object ordering while preserving exact numeric values.
      const same = await db.query(
        'select input=$2::jsonb as same from import_runtime.requests where idempotency_key=$1',
        [key, JSON.stringify(semanticInput)],
      )
      if (!same.rows[0].same)
        throw new ApiFailure(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key already belongs to different input.',
        )
      const request = requestProjection(
        existing.rows[0],
        await getJob(db, existing.rows[0].job_id),
      )
      await db.query('commit')
      return request
    }
    if (!sources.length)
      throw new ApiFailure(409, 'NO_ENABLED_SOURCES', 'No sources are enabled.')
    const config = { sources, filters: {}, referenceVersion: 'synthetic-v1' }
    const scopeKey = createHash('sha256')
      .update(JSON.stringify({ area, config }))
      .digest('hex')
    const job: ImportJob = {
      id: randomUUID(),
      area,
      scopeKey,
      state: 'queued',
      stage: 'queued',
      createdAt: now.toISOString(),
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
      sources: sources.map(({ sourceId }) => ({
        sourceId,
        state: 'queued',
        coverage: 'unknown',
        error: null,
      })),
      coverage: coverage(),
      reasons: [],
      error: null,
      continuation: {
        available: false,
        fromJobId: null,
        restarted: false,
        restartReason: null,
      },
    }
    await db.query(
      'insert into import_runtime.jobs(id,document,area,scope_key,config) values($1,$2,$3,$4,$5)',
      [job.id, job, area, scopeKey, config],
    )
    for (const source of sources)
      await db.query(
        'insert into import_runtime.source_tasks(job_id,source_id,document) values($1,$2,$3)',
        [job.id, source.sourceId, { cursor: null, state: 'queued' }],
      )
    const id = randomUUID()
    const row = await db.query(
      'insert into import_runtime.requests(id,idempotency_key,input,job_id,created_at) values($1,$2,$3,$4,$5) returning *',
      [id, key, semanticInput, job.id, now],
    )
    await db.query('commit')
    return requestProjection(row.rows[0], job)
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally {
    db.release()
  }
}
