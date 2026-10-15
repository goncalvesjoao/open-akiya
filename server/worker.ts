import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ListingProjection, Location } from '../src/listings/contracts'
import type {
  AdapterCapabilities,
  ImportJob,
  SourceAdapter,
  SourceObservation,
} from './contracts'

export type WorkerOptions = {
  pool: Pool
  adapters: SourceAdapter[]
  transport: (url: string, options?: RequestInit) => Promise<Response>
  now?: () => Date
}
const executorLock = 137013
async function saveJob(db: PoolClient, job: ImportJob) {
  await db.query('update import_runtime.jobs set document=$2 where id=$1', [
    job.id,
    job,
  ])
}
function allowedUrl(url: string, capabilities: AdapterCapabilities) {
  const parsed = new URL(url)
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !capabilities.allowedHosts.includes(parsed.hostname)
  )
    throw new Error('Invalid source URL')
}
function validateObservation(
  observation: SourceObservation,
  adapter: SourceAdapter,
) {
  if (
    observation.identity.sourceId !== adapter.capabilities.sourceId ||
    !observation.identity.externalId ||
    !Number.isFinite(Date.parse(observation.sourceCheckedAt))
  )
    throw new Error('Invalid source observation')
  allowedUrl(observation.url, adapter.capabilities)
  for (const value of [
    observation.fields.salePriceJpy,
    observation.fields.rentMonthlyJpy,
  ])
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isSafeInteger(value) || value < 0)
    )
      throw new Error('Invalid money')
  for (const value of [
    observation.fields.floorAreaM2,
    observation.fields.landAreaM2,
  ])
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isFinite(value) || value <= 0)
    )
      throw new Error('Invalid area')
  if (
    typeof observation.fields.titleJa !== 'string' ||
    !observation.fields.titleJa.trim()
  )
    throw new Error('Missing title')
}
function approvedLocation(location: Location): Location {
  switch (location.kind) {
    case 'verified':
      return {
        kind: 'verified',
        point: {
          latitude: location.point.latitude,
          longitude: location.point.longitude,
        },
        evidence: location.evidence,
        verifiedAt: location.verifiedAt,
      }
    case 'unverified':
      return {
        kind: 'unverified',
        point: {
          latitude: location.point.latitude,
          longitude: location.point.longitude,
        },
        precision: location.precision,
        sourceId: location.sourceId,
      }
    case 'municipality':
      return { kind: 'municipality', municipalityId: location.municipalityId }
    case 'unknown':
      return { kind: 'unknown' }
    default:
      throw new Error('Invalid location')
  }
}
async function commitObservation(
  db: PoolClient,
  job: ImportJob,
  observation: SourceObservation,
  adapter: SourceAdapter,
) {
  validateObservation(observation, adapter)
  const committedCounts = { ...job.counts }
  await db.query('begin')
  try {
    const previous = await db.query(
      'select o.*,p.document as projection from import_runtime.observations o join import_runtime.projections p on p.listing_id=o.listing_id where source_id=$1 and external_id=$2',
      [observation.identity.sourceId, observation.identity.externalId],
    )
    const old = previous.rows[0]
    const id = old?.listing_id ?? randomUUID()
    // Never spread source-owned objects into the browser projection.
    const {
      titleJa,
      transactionType,
      salePriceJpy,
      rentMonthlyJpy,
      priceNoteJa,
      propertyType,
      floorAreaM2,
      landAreaM2,
      prefecture,
      municipalityId,
      municipalityNameJa,
      availability,
      location,
    } = observation.fields
    const fields = Object.fromEntries(
      Object.entries({
        titleJa,
        transactionType,
        salePriceJpy,
        rentMonthlyJpy,
        priceNoteJa,
        propertyType,
        floorAreaM2,
        landAreaM2,
        prefecture,
        municipalityId,
        municipalityNameJa,
        availability,
        location:
          location === undefined ? undefined : approvedLocation(location),
      }).filter(([, value]) => value !== undefined),
    )
    const projection: ListingProjection = {
      id,
      titleJa: observation.fields.titleJa!,
      sourceRefs: [
        {
          sourceId: observation.identity.sourceId,
          externalId: observation.identity.externalId,
          name:
            adapter.capabilities.sourceId === 'fixture'
              ? 'Sample source'
              : adapter.capabilities.sourceId,
          url: observation.url,
        },
      ],
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
      ...old?.projection,
      ...fields,
      lastSeenAt: observation.sourceCheckedAt,
      sourceCheckedAt: observation.sourceCheckedAt,
    }
    const point =
      projection.location.kind === 'verified' ||
      projection.location.kind === 'unverified'
        ? projection.location.point
        : null
    await db.query(
      `insert into public.listings(id,source_url,source_name,title_ja,prefecture,price_jpy,latitude,longitude,source_checked_at,transaction_type,rent_monthly_jpy,price_note_ja,property_type,floor_area_m2,land_area_m2,municipality_id,municipality,availability,location,first_seen_at,last_seen_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$9)
      on conflict(id) do update set title_ja=excluded.title_ja,price_jpy=excluded.price_jpy,source_checked_at=excluded.source_checked_at,last_seen_at=excluded.last_seen_at`,
      [
        id,
        projection.primarySourceUrl,
        projection.sourceRefs[0].name,
        projection.titleJa,
        projection.prefecture ?? '',
        projection.salePriceJpy,
        point?.latitude ?? null,
        point?.longitude ?? null,
        observation.sourceCheckedAt,
        projection.transactionType,
        projection.rentMonthlyJpy,
        projection.priceNoteJa,
        projection.propertyType,
        projection.floorAreaM2,
        projection.landAreaM2,
        projection.municipalityId,
        projection.municipalityNameJa,
        projection.availability,
        projection.location,
        projection.firstSeenAt,
      ],
    )
    await db.query(
      'insert into import_runtime.projections(listing_id,document) values($1,$2) on conflict(listing_id) do update set document=excluded.document',
      [id, projection],
    )
    await db.query(
      'insert into import_runtime.observations(source_id,external_id,listing_id,document,content_hash) values($1,$2,$3,$4,$5) on conflict(source_id,external_id) do update set document=excluded.document,content_hash=excluded.content_hash',
      [
        observation.identity.sourceId,
        observation.identity.externalId,
        id,
        observation,
        observation.contentHash,
      ],
    )
    job.counts[
      !old
        ? 'added'
        : old.content_hash === observation.contentHash
          ? 'unchanged'
          : 'updated'
    ]++
    await saveJob(db, job)
    await db.query('commit')
  } catch (error) {
    await db.query('rollback')
    job.counts = committedCounts
    throw error
  }
}
export async function runWorkerOnce(options: WorkerOptions): Promise<boolean> {
  const db = await options.pool.connect()
  let locked = false
  const now = options.now ?? (() => new Date())
  try {
    locked = (
      await db.query('select pg_try_advisory_lock($1) as locked', [
        executorLock,
      ])
    ).rows[0].locked
    if (!locked) return false
    await db.query('begin')
    const claimed = await db.query(
      "select * from import_runtime.jobs where document->>'state'='queued' order by document->>'createdAt',id for update skip locked limit 1",
    )
    if (!claimed.rowCount) {
      await db.query('commit')
      return false
    }
    const job: ImportJob = claimed.rows[0].document
    job.state = 'running'
    job.stage = 'discovering'
    job.startedAt = now().toISOString()
    await saveJob(db, job)
    await db.query('commit')
    const frozenSources: AdapterCapabilities[] = claimed.rows[0].config.sources
    try {
      for (const source of job.sources) {
        source.state = 'running'
        const adapter = options.adapters.find(
          (value) => value.capabilities.sourceId === source.sourceId,
        )
        const frozen = frozenSources.find(
          (value) => value.sourceId === source.sourceId,
        )
        if (!adapter || !isDeepStrictEqual(adapter.capabilities, frozen))
          throw new Error('Adapter configuration changed')
        const controller = new AbortController()
        const context = {
          now,
          signal: controller.signal,
          request: async (
            kind: 'discovery' | 'detail',
            url: string,
            requestOptions?: RequestInit,
          ): Promise<Response> => {
            allowedUrl(url, adapter.capabilities)
            const used = kind === 'discovery' ? 'discoveryUsed' : 'detailUsed'
            const limit =
              kind === 'discovery' ? 'discoveryLimit' : 'detailLimit'
            if (job.budget[used] >= job.budget[limit])
              throw new Error('Budget exceeded')
            job.budget[used]++
            await saveJob(db, job)
            // Manual redirects prevent transports from hiding uncharged or unvalidated hops.
            const response = await options.transport(url, {
              ...requestOptions,
              redirect: 'manual',
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(30000),
              ]),
            })
            if (!response.ok) throw new Error('Source request failed')
            return response
          },
        }
        let cursor: string | null = null
        const seen = new Set<string>()
        do {
          job.stage = 'discovering'
          await saveJob(db, job)
          const page = await adapter.discover(
            { area: job.area, queryKey: job.scopeKey, cursor },
            context,
          )
          for (const candidate of page.candidates) {
            if (seen.has(candidate.externalId)) continue
            seen.add(candidate.externalId)
            job.counts.discovered++
            if (candidate.relevance === 'known_outside') continue
            job.stage = 'fetching'
            await saveJob(db, job)
            allowedUrl(candidate.url, adapter.capabilities)
            const evidence = await adapter.fetchDetail(candidate, context)
            job.counts.checked++
            const normalized = adapter.normalize(evidence)
            if (normalized.kind === 'rejected') {
              job.counts.rejected++
              continue
            }
            if (
              normalized.observation.identity.externalId !==
              candidate.externalId
            )
              throw new Error('Identity mismatch')
            job.stage = 'saving'
            await saveJob(db, job)
            await commitObservation(db, job, normalized.observation, adapter)
          }
          cursor = page.nextCursor
          if (page.exhausted && !page.limitation) {
            source.coverage = 'complete'
            break
          }
          if (!cursor || page.limitation) {
            source.coverage = 'partial'
            break
          }
        } while (cursor)
        source.state =
          source.coverage === 'complete' && !job.counts.rejected
            ? 'succeeded'
            : 'partial'
        await db.query(
          'update import_runtime.source_tasks set document=$3 where job_id=$1 and source_id=$2',
          [
            job.id,
            source.sourceId,
            { state: source.state, cursor, coverage: source.coverage },
          ],
        )
      }
      job.state = job.sources.every((source) => source.state === 'succeeded')
        ? 'succeeded'
        : 'partial'
    } catch {
      job.state =
        job.counts.added + job.counts.updated + job.counts.unchanged > 0
          ? 'partial'
          : 'failed'
      job.error = {
        code: 'SOURCE_ERROR',
        message: 'Synthetic source processing could not complete.',
        retryable: false,
      }
      job.reasons = ['SOURCE_ERROR']
      for (const source of job.sources)
        if (source.state === 'running') {
          source.state = 'failed'
          source.error = job.error
        }
    }
    job.stage = 'finished'
    job.finishedAt = now().toISOString()
    await saveJob(db, job)
    return true
  } finally {
    if (locked) await db.query('select pg_advisory_unlock($1)', [executorLock])
    db.release()
  }
}
