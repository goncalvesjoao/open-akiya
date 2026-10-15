import { createHash } from 'node:crypto'
import type { ApiError } from '../shared/desktop'
import type {
  ListingProjection,
  Location,
  SelectedArea,
} from '../shared/listings'
import { distanceMetres } from '../shared/geography'
import { fixtures, municipalitySourcePointEvidence } from './fixtures'
import { municipalityReference } from './municipalities'

export type AdapterCapabilities = {
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
export type Candidate = {
  externalId: string
  transactionType: ListingProjection['transactionType']
  url: string
  location: Location
  municipalityId: string | null
  publishedAt: string | null
  modifiedAt: string | null
  relevance: 'known_inside' | 'plausible' | 'known_outside'
}
export type DiscoveryPage = {
  candidates: Candidate[]
  nextCursor: string | null
  exhausted: boolean
  limitation: string | null
}
export type DetailEvidence = {
  identity: { sourceId: string; externalId: string }
  url: string
  fetchedAt: string
  payload: unknown
  provenance: Record<string, string>
}
export type NormalizedFields = Omit<
  ListingProjection,
  | 'id'
  | 'sourceRefs'
  | 'primarySourceUrl'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'sourceCheckedAt'
>
export type SourceObservation = {
  identity: { sourceId: string; externalId: string }
  url: string
  adapterVersion: string
  sourceCheckedAt: string
  fields: Partial<NormalizedFields>
  provenance: Record<string, string>
  contentHash: string
}
export type NormalizationResult =
  | { kind: 'accepted'; observation: SourceObservation }
  | { kind: 'rejected'; error: ApiError }
export type AdapterContext = {
  signal: AbortSignal
  now(): string
  request(
    kind: 'discovery' | 'detail',
    url: string,
    options?: RequestInit,
  ): Promise<unknown>
}
export interface SourceAdapter {
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

// Fixed coordinates and identities: requesting a different area never relocates evidence.
export function syntheticAdapter(
  delayMs = 300,
  offers: ListingProjection[] = [fixtures[0]],
): SourceAdapter {
  offers = offers.map((offer): ListingProjection => {
    const municipalityId =
      municipalitySourcePointEvidence[offer.sourceRefs[0].externalId]
    return municipalityId && offer.sourceRefs[0].sourceId === 'fixture'
      ? {
          ...offer,
          municipalityId,
          location: { kind: 'municipality', municipalityId },
        }
      : offer
  })
  const listing = offers[0]
  const source = listing.sourceRefs[0]
  return {
    capabilities: {
      sourceId: source.sourceId,
      adapterVersion: 'synthetic-v1',
      queryVersion: 'circle-v1',
      geography: 'circle',
      dateOrdering: null,
      cursorVersion: 'v1',
      allowedHosts: ['example.invalid'],
    },
    async discover({ area }, context) {
      await context.request('discovery', 'https://example.invalid/discovery')
      const inside = offers.filter((offer) =>
        offer.location.kind === 'municipality'
          ? Boolean(municipalityReference(offer.location.municipalityId, area))
          : (offer.location.kind === 'verified' ||
              offer.location.kind === 'unverified') &&
            distanceMetres(area.center, offer.location.point) <=
              area.radiusKm * 1000 + 1e-8,
      )
      return {
        candidates: inside.map((offer) => ({
          externalId: offer.sourceRefs[0].externalId,
          transactionType: offer.transactionType,
          url: offer.primarySourceUrl,
          location: offer.location,
          municipalityId: offer.municipalityId,
          publishedAt: null,
          modifiedAt: null,
          relevance:
            offer.location.kind === 'verified' ? 'known_inside' : 'plausible',
        })),
        nextCursor: null,
        exhausted: true,
        limitation: null,
      }
    },
    async fetchDetail(candidate, context) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      context.signal.throwIfAborted()
      await context.request('detail', candidate.url)
      return {
        identity: {
          sourceId: source.sourceId,
          externalId: candidate.externalId,
        },
        url: candidate.url,
        fetchedAt: context.now(),
        payload: listing,
        provenance: { fixture: 'Authored synthetic offer, not real inventory' },
      }
    },
    normalize(evidence) {
      const listing =
        offers.find(
          (offer) =>
            offer.sourceRefs[0].externalId === evidence.identity.externalId,
        ) ?? offers[0]
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
      } = listing
      const fields = {
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
      }
      return {
        kind: 'accepted',
        observation: {
          identity: evidence.identity,
          url: evidence.url,
          adapterVersion: 'synthetic-v1',
          sourceCheckedAt: evidence.fetchedAt,
          fields,
          provenance: evidence.provenance,
          contentHash: createHash('sha256')
            .update(JSON.stringify(fields))
            .digest('hex'),
        },
      }
    },
  }
}
