import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Pool } from 'pg'
import { isSelectedArea, distanceMetres } from '../src/listings/query'
import type { AreaResults, ListingProjection } from '../src/listings/contracts'
import type { AdapterCapabilities } from './contracts'
import {
  ApiFailure,
  coverage,
  createRequest,
  getJob,
  requestProjection,
} from './store'
import { syntheticCapabilities } from './synthetic'

export type RuntimeOptions = {
  pool: Pool
  sessionToken: string
  allowedOrigins: string[]
  port?: number
  sources?: AdapterCapabilities[]
  now?: () => Date
}
export async function createRuntime(options: RuntimeOptions) {
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (status: number, body: unknown) => {
      response.writeHead(status)
      response.end(JSON.stringify(body))
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const origin = request.headers.origin
      if (origin && !options.allowedOrigins.includes(origin))
        throw new ApiFailure(
          403,
          'FORBIDDEN',
          'Installation authorization required.',
        )
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin)
        response.setHeader('Vary', 'Origin')
      }
      if (request.method === 'OPTIONS') {
        if (!origin)
          throw new ApiFailure(
            403,
            'FORBIDDEN',
            'Installation authorization required.',
          )
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        response.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Idempotency-Key, X-Installation-Session',
        )
        return send(204, null)
      }
      let body: unknown
      if (request.method === 'POST') {
        const token = request.headers['x-installation-session']
        if (
          !origin ||
          typeof token !== 'string' ||
          Buffer.byteLength(token) !==
            Buffer.byteLength(options.sessionToken) ||
          !timingSafeEqual(
            Buffer.from(token),
            Buffer.from(options.sessionToken),
          )
        )
          throw new ApiFailure(
            403,
            'FORBIDDEN',
            'Installation authorization required.',
          )
        if (
          request.headers['content-type']?.split(';')[0] !== 'application/json'
        )
          throw new ApiFailure(400, 'INVALID_REQUEST', 'Use application/json.')
        let text = ''
        for await (const chunk of request) {
          text += chunk
          if (Buffer.byteLength(text) > 16384)
            throw new ApiFailure(
              413,
              'INVALID_REQUEST',
              'Request body too large.',
            )
        }
        try {
          body = JSON.parse(text)
        } catch {
          throw new ApiFailure(400, 'INVALID_REQUEST', 'Invalid JSON.')
        }
      }
      if (
        request.method === 'POST' &&
        ['/api/import-requests', '/api/area-results'].includes(url.pathname)
      ) {
        if (
          typeof body !== 'object' ||
          body === null ||
          !('area' in body) ||
          !isSelectedArea(body.area)
        )
          throw new ApiFailure(
            400,
            'INVALID_REQUEST',
            'Choose finite coordinates and radius greater than 0 and at most 10 km.',
          )
        const area = {
          center: {
            latitude: body.area.center.latitude,
            longitude: body.area.center.longitude,
          },
          radiusKm: body.area.radiusKm,
        }
        if (url.pathname === '/api/import-requests') {
          const key = request.headers['idempotency-key']
          if (
            !('intent' in body) ||
            body.intent !== 'import' ||
            typeof key !== 'string' ||
            !key.trim() ||
            key.length > 200
          )
            throw new ApiFailure(
              400,
              'INVALID_REQUEST',
              'Use intent import and a nonempty Idempotency-Key (at most 200 characters).',
            )
          return send(
            202,
            await createRequest(
              options.pool,
              area,
              key,
              options.sources ?? [syntheticCapabilities],
              options.now?.() ?? new Date(),
            ),
          )
        }
        if (
          !('showUnavailable' in body) ||
          typeof body.showUnavailable !== 'boolean'
        )
          throw new ApiFailure(
            400,
            'INVALID_REQUEST',
            'showUnavailable must be a boolean.',
          )
        const rows = await options.pool.query(
          'select document from import_runtime.projections',
        )
        const listings = rows.rows
          .map((row) => row.document as ListingProjection)
          .filter(
            (listing) =>
              (body.showUnavailable ||
                listing.availability !== 'unavailable') &&
              (listing.location.kind === 'verified' ||
                listing.location.kind === 'unverified') &&
              distanceMetres(area.center, listing.location.point) <=
                area.radiusKm * 1000 + 1e-8,
          )
        const result: AreaResults = {
          area,
          showUnavailable: body.showUnavailable,
          mode: 'synthetic',
          listings,
          municipalityGroups: [],
          coverage: coverage(),
          generatedAt: (options.now?.() ?? new Date()).toISOString(),
        }
        return send(200, result)
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/import-jobs' &&
        url.search === '?state=active'
      ) {
        const result = await options.pool.query(
          "select document from import_runtime.jobs where document->>'state' in ('queued','running') order by document->>'createdAt',id",
        )
        return send(200, { jobs: result.rows.map((row) => row.document) })
      }
      const jobMatch = url.pathname.match(/^\/api\/import-jobs\/([^/]+)$/)
      if (request.method === 'GET' && jobMatch)
        return send(200, await getJob(options.pool, jobMatch[1]))
      const requestMatch = url.pathname.match(
        /^\/api\/import-requests\/([^/]+)$/,
      )
      if (request.method === 'GET' && requestMatch) {
        const result = await options.pool.query(
          'select * from import_runtime.requests where id=$1',
          [requestMatch[1]],
        )
        if (!result.rowCount)
          throw new ApiFailure(404, 'NOT_FOUND', 'Unknown request.')
        return send(
          200,
          requestProjection(
            result.rows[0],
            await getJob(options.pool, result.rows[0].job_id),
          ),
        )
      }
      throw new ApiFailure(404, 'NOT_FOUND', 'Unknown resource.')
    } catch (error) {
      if (error instanceof ApiFailure)
        return send(error.status, {
          error: { code: error.code, message: error.message, retryable: false },
        })
      send(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Local runtime could not complete the request.',
          retryable: true,
        },
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing listener')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
