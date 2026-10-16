import type { ImportJob, ImportRequest } from './desktop'
import { initialArea } from './geography'

export const runningImportJob: ImportJob = {
  id: 'fixture-job',
  area: initialArea,
  state: 'running',
  stage: 'discovering',
  createdAt: '2026-10-15T00:00:00Z',
  startedAt: '2026-10-15T00:00:01Z',
  finishedAt: null,
  scopeKey: 'fixture-scope',
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
  sources: [
    { sourceId: 'fixture', state: 'running', coverage: 'unknown', error: null },
  ],
  coverage: {
    status: 'unknown',
    lastSuccessfulCheckAt: null,
    freshUntil: null,
    scopeKey: 'fixture-scope',
    caveats: [],
  },
  reasons: [],
  continuation: {
    available: false,
    fromJobId: null,
    restarted: false,
    restartReason: null,
  },
  error: null,
}

export const queuedImportRequest: ImportRequest = {
  id: 'request',
  area: initialArea,
  intent: 'import',
  disposition: 'created',
  state: 'queued',
  jobIds: [runningImportJob.id],
  pendingFollowUp: false,
  createdAt: runningImportJob.createdAt,
  finishedAt: null,
  error: null,
}
export const attachedImportRequest: ImportRequest = {
  ...queuedImportRequest,
  id: 'attached-request',
  area: { ...initialArea, radiusKm: 1 },
  disposition: 'attached',
  state: 'running',
}
export const overlappingQueuedImportJob: ImportJob = {
  ...runningImportJob,
  id: 'overlapping-job',
  area: { ...initialArea, center: { latitude: 35, longitude: 135.01 } },
  state: 'queued',
  stage: 'queued',
  startedAt: null,
  sources: [
    { sourceId: 'fixture', state: 'queued', coverage: 'unknown', error: null },
  ],
}
export const overlappingQueuedImportRequest: ImportRequest = {
  ...queuedImportRequest,
  id: 'overlapping-request',
  area: overlappingQueuedImportJob.area,
  jobIds: [overlappingQueuedImportJob.id],
}
export const detachedImportRequest: ImportRequest = {
  ...attachedImportRequest,
  state: 'cancelled',
  finishedAt: '2026-10-15T00:00:02Z',
}
