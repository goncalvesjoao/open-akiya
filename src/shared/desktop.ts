import type { AreaQuery, AreaResults, SelectedArea } from './listings'

export type JobState =
  'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type Job = {
  id: string
  area: SelectedArea
  state: JobState
  stage: 'queued' | 'discovering' | 'saving' | 'finished'
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  added: number
  updated: number
  processed: number
  error: string | null
}
export type CreateImport = { area: SelectedArea; idempotencyKey: string }
export type DesktopAPI = {
  createImport(input: CreateImport): Promise<Job>
  inspectImport(id: string): Promise<Job>
  cancelImport(id: string): Promise<Job>
  listImports(): Promise<Job[]>
  areaResults(query: AreaQuery): Promise<AreaResults>
}
export type Operation =
  | 'createImport'
  | 'inspectImport'
  | 'cancelImport'
  | 'listImports'
  | 'areaResults'
  | 'shutdown'
export type WorkerRequest = { id: number; operation: Operation; input: unknown }
export type WorkerReply = { id: number; result?: unknown; error?: string }
