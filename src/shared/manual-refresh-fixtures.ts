import type { ImportJob, ImportRequest } from './desktop'
import { runningImportJob, queuedImportRequest } from './import-fixtures'

// Full inspection responses shared with #7; the cutoff remains worker-private.
const attached: ImportRequest = {
  ...queuedImportRequest,
  id: 'request-refresh',
  intent: 'manual_refresh',
  disposition: 'attached',
  state: 'running',
  pendingFollowUp: true,
  createdAt: '2026-10-15T00:00:05Z',
}
const ordinary: ImportJob = {
  ...runningImportJob,
  state: 'succeeded',
  stage: 'finished',
  finishedAt: '2026-10-15T00:00:30Z',
  counts: { ...runningImportJob.counts, discovered: 3, checked: 1, added: 1 },
  budget: { ...runningImportJob.budget, discoveryUsed: 1, detailUsed: 1 },
  sources: [
    {
      sourceId: 'fixture',
      state: 'succeeded',
      coverage: 'complete',
      error: null,
    },
  ],
  coverage: {
    ...runningImportJob.coverage,
    status: 'complete',
    lastSuccessfulCheckAt: '2026-10-15T00:00:30Z',
    freshUntil: '2026-10-16T00:00:00Z',
  },
}
const queued: ImportJob = {
  ...runningImportJob,
  id: 'job-refresh-1',
  state: 'queued',
  stage: 'queued',
  createdAt: ordinary.finishedAt!,
  startedAt: null,
  sources: [
    { sourceId: 'fixture', state: 'queued', coverage: 'complete', error: null },
  ],
  continuation: { ...runningImportJob.continuation, fromJobId: ordinary.id },
}
const pending: ImportRequest = {
  ...attached,
  state: 'queued',
  jobIds: [ordinary.id, queued.id],
}
const succeeded: ImportJob = {
  ...queued,
  state: 'succeeded',
  stage: 'finished',
  startedAt: '2026-10-15T00:00:31Z',
  finishedAt: '2026-10-15T00:00:36Z',
  counts: { ...queued.counts, checked: 2, updated: 1, unchanged: 1 },
  budget: { ...queued.budget, detailUsed: 2 },
  sources: [
    {
      sourceId: 'fixture',
      state: 'succeeded',
      coverage: 'complete',
      error: null,
    },
  ],
  coverage: {
    ...queued.coverage,
    status: 'complete',
    lastSuccessfulCheckAt: '2026-10-15T00:00:36Z',
    freshUntil: '2026-10-16T00:00:36Z',
  },
}
const completed: ImportRequest = {
  ...pending,
  state: 'succeeded',
  pendingFollowUp: false,
  finishedAt: succeeded.finishedAt,
}
const partial: ImportJob = {
  ...succeeded,
  state: 'partial',
  counts: { ...queued.counts, checked: 1, updated: 1 },
  budget: { ...queued.budget, detailUsed: 1, detailLimit: 1 },
  sources: [
    {
      sourceId: 'fixture',
      state: 'partial',
      coverage: 'complete',
      error: {
        code: 'BUDGET_EXHAUSTED',
        message: 'Deferred refresh work remains',
        retryable: false,
      },
    },
  ],
  coverage: {
    ...queued.coverage,
    status: 'complete',
    caveats: ['Required import work is incomplete; saved results retained.'],
  },
  reasons: ['BUDGET_EXHAUSTED'],
  error: {
    code: 'BUDGET_EXHAUSTED',
    message: 'Deferred refresh work remains',
    retryable: false,
  },
  continuation: { ...queued.continuation, available: true },
}
const exhausted: ImportRequest = {
  ...completed,
  state: 'partial',
  error: partial.error,
}
const cancelled: ImportRequest = {
  ...pending,
  state: 'cancelled',
  pendingFollowUp: false,
  finishedAt: '2026-10-15T00:00:31Z',
}
const running: ImportJob = {
  ...queued,
  state: 'running',
  stage: 'fetching',
  startedAt: '2026-10-15T00:00:31Z',
}
const failure = {
  code: 'SOURCE_BLOCKED',
  message: 'Source request blocked',
  retryable: false,
}
const failed: ImportJob = {
  ...partial,
  state: 'failed',
  counts: { ...queued.counts },
  sources: [
    {
      sourceId: 'fixture',
      state: 'failed',
      coverage: 'complete',
      error: failure,
    },
  ],
  error: failure,
  reasons: [failure.code],
}
const failedRequest: ImportRequest = {
  ...exhausted,
  state: 'failed',
  error: failure,
}
const cancelledJob: ImportJob = {
  ...queued,
  state: 'cancelled',
  stage: 'finished',
  cancelRequestedAt: cancelled.finishedAt,
  finishedAt: cancelled.finishedAt,
  sources: [
    {
      sourceId: 'fixture',
      state: 'cancelled',
      coverage: 'complete',
      error: null,
    },
  ],
  reasons: ['USER_CANCELLED'],
  continuation: { ...queued.continuation, available: true },
}
export const manualRefreshFixtures = {
  running,
  failed,
  failedRequest,
  cancelledJob,
  attached,
  ordinary,
  queued,
  pending,
  succeeded,
  completed,
  partial,
  exhausted,
  cancelled,
}
