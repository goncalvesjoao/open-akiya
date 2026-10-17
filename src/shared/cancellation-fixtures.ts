import type { ImportJob, ImportRequest } from './desktop'
import {
  runningImportJob,
  overlappingQueuedImportJob,
  attachedImportRequest,
} from './import-fixtures'

// Complete server responses, shared by renderer and SQLite worker seam tests.
export const cancellationRequestedJob: ImportJob = {
  ...runningImportJob,
  cancelRequestedAt: '2026-10-15T00:00:02Z',
  reasons: ['USER_CANCELLED'],
  counts: { ...runningImportJob.counts, discovered: 2, checked: 1, added: 1 },
}
export const cancelledImportJob: ImportJob = {
  ...cancellationRequestedJob,
  state: 'cancelled',
  stage: 'finished',
  finishedAt: '2026-10-15T00:00:03Z',
  sources: [
    {
      sourceId: 'fixture',
      state: 'cancelled',
      coverage: 'unknown',
      error: null,
    },
  ],
}
export const cancelledQueuedImportJob: ImportJob = {
  ...overlappingQueuedImportJob,
  state: 'cancelled',
  stage: 'finished',
  cancelRequestedAt: '2026-10-15T00:00:02Z',
  finishedAt: '2026-10-15T00:00:02Z',
  reasons: ['USER_CANCELLED'],
  sources: [
    {
      sourceId: 'fixture',
      state: 'cancelled',
      coverage: 'unknown',
      error: null,
    },
  ],
}
export const cancelledAttachedRequest: ImportRequest = {
  ...attachedImportRequest,
  state: 'cancelled',
  pendingFollowUp: false,
  finishedAt: '2026-10-15T00:00:02Z',
}
