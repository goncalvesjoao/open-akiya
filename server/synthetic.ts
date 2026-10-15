import { createHash } from 'node:crypto'
import type {
  AdapterCapabilities,
  SourceAdapter,
  NormalizedFields,
} from './contracts'
import { distanceMetres } from '../src/listings/query'
export const syntheticCapabilities: AdapterCapabilities = {
  sourceId: 'fixture',
  adapterVersion: '1',
  queryVersion: '1',
  geography: 'circle',
  dateOrdering: null,
  cursorVersion: '1',
  allowedHosts: ['example.invalid'],
}
const point = { latitude: 35.001, longitude: 135 }
const url = 'https://example.invalid/offers/sale-1'
const fields: NormalizedFields = {
  titleJa: 'サンプル売却情報',
  transactionType: 'sale',
  salePriceJpy: 0,
  rentMonthlyJpy: null,
  priceNoteJa: null,
  propertyType: null,
  floorAreaM2: null,
  landAreaM2: null,
  prefecture: null,
  municipalityId: null,
  municipalityNameJa: null,
  availability: 'unknown',
  location: {
    kind: 'unverified',
    point,
    precision: 'approximate',
    sourceId: 'fixture',
  },
}
// This transport never accesses a network; adapters still use the worker's charged boundary.
export async function syntheticTransport(
  requestUrl: string,
  options?: RequestInit,
): Promise<Response> {
  options?.signal?.throwIfAborted()
  const parsed = new URL(requestUrl)
  if (parsed.hostname !== 'example.invalid')
    throw new Error('Unsupported fixture host')
  return Response.json(
    parsed.pathname === '/discovery' ? { available: true } : fields,
  )
}
export function createSyntheticAdapter(): SourceAdapter {
  return {
    capabilities: syntheticCapabilities,
    async discover({ area }, context) {
      await context.request('discovery', 'https://example.invalid/discovery')
      return {
        candidates:
          distanceMetres(area.center, point) <= area.radiusKm * 1000 + 1e-8
            ? [
                {
                  externalId: 'sale-1',
                  transactionType: 'sale',
                  url,
                  location: fields.location,
                  municipalityId: null,
                  publishedAt: null,
                  modifiedAt: null,
                  relevance: 'known_inside',
                },
              ]
            : [],
        nextCursor: null,
        exhausted: true,
        limitation: null,
      }
    },
    async fetchDetail(candidate, context) {
      const response = await context.request('detail', candidate.url)
      return {
        identity: { sourceId: 'fixture', externalId: candidate.externalId },
        url: candidate.url,
        fetchedAt: context.now().toISOString(),
        payload: await response.json(),
        provenance: { mode: 'synthetic' },
      }
    },
    normalize(evidence) {
      return {
        kind: 'accepted',
        observation: {
          identity: evidence.identity,
          url: evidence.url,
          adapterVersion: '1',
          sourceCheckedAt: evidence.fetchedAt,
          fields: evidence.payload as NormalizedFields,
          provenance: evidence.provenance,
          contentHash: createHash('sha256')
            .update(JSON.stringify(evidence.payload))
            .digest('hex'),
        },
      }
    },
  }
}
