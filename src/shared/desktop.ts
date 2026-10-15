import type { LocationSearchResults } from './location-search'
import type { AreaQuery, AreaResults, Coverage, SelectedArea } from './listings'

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
export type Job = ImportJob
export type CreateImport =
  | {
      intent: 'continue'
      fromJobId: string
      idempotencyKey: string
    }
  | {
      area: SelectedArea
      intent: 'import'
      idempotencyKey: string
    }
export type DesktopAPI = {
  searchLocations(query: string): Promise<LocationSearchResults>
  createImportRequest(input: CreateImport): Promise<ImportRequest>
  inspectImportRequest(id: string): Promise<ImportRequest>
  inspectImport(id: string): Promise<ImportJob>
  cancelImport(id: string): Promise<ImportJob>
  cancelImportRequest(id: string): Promise<ImportRequest>
  listImports(input: { state: 'active' }): Promise<{ jobs: ImportJob[] }>
  areaResults(query: AreaQuery): Promise<AreaResults>
}
export type Operation = keyof DesktopAPI | 'shutdown'
export type WorkerRequest = { id: number; operation: Operation; input: unknown }
export type WorkerReply = { id: number; result?: unknown; error?: ApiError }
