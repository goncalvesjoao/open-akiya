import type {
  Coverage,
  ListingProjection,
  Location,
  SelectedArea,
} from '../src/listings/contracts'
export type JobState =
  'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type ApiError = { code: string; message: string; retryable: boolean }
export type ImportRequest = {
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
export type ImportJob = {
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
export type SourceIdentity = { sourceId: string; externalId: string }
export type DetailEvidence = {
  identity: SourceIdentity
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
  identity: SourceIdentity
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
  now: () => Date
  request: (
    kind: 'discovery' | 'detail',
    url: string,
    options?: RequestInit,
  ) => Promise<Response>
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
