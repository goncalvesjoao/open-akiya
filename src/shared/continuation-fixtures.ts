import type { ImportJob, ImportRequest } from './desktop'
import { initialArea } from './geography'

// Full #6 inspection responses for worker/UI contract consumers; synthetic only.
const queued: ImportJob = {
  id: 'job-2',
  area: initialArea,
  scopeKey: 'fixture-scope-v1',
  state: 'queued',
  stage: 'queued',
  createdAt: '2026-10-15T00:01:00Z',
  startedAt: null,
  finishedAt: null,
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
    { sourceId: 'fixture', state: 'queued', coverage: 'partial', error: null },
  ],
  coverage: {
    status: 'partial',
    lastSuccessfulCheckAt: null,
    freshUntil: null,
    scopeKey: 'fixture-scope-v1',
    caveats: ['Synthetic fixtures only; discovery incomplete'],
  },
  reasons: [],
  error: null,
  continuation: {
    available: false,
    fromJobId: 'job-1',
    restarted: false,
    restartReason: null,
  },
}
const partial: ImportJob = {
  ...queued,
  id: 'job-1',
  state: 'partial',
  stage: 'finished',
  createdAt: '2026-10-15T00:00:00Z',
  startedAt: '2026-10-15T00:00:01Z',
  finishedAt: '2026-10-15T00:00:30Z',
  counts: { ...queued.counts, discovered: 3, checked: 2, added: 2 },
  budget: { ...queued.budget, discoveryUsed: 10, detailUsed: 2 },
  sources: [
    { sourceId: 'fixture', state: 'partial', coverage: 'partial', error: null },
  ],
  reasons: ['DISCOVERY_BUDGET_EXHAUSTED'],
  continuation: { ...queued.continuation, fromJobId: null, available: true },
}
const cancelled: ImportJob = {
  ...partial,
  id: 'job-cancelled',
  state: 'cancelled',
  cancelRequestedAt: partial.finishedAt,
  sources: [
    {
      sourceId: 'fixture',
      state: 'cancelled',
      coverage: 'partial',
      error: null,
    },
  ],
  reasons: ['USER_CANCELLED'],
}
const failure = {
  code: 'SOURCE_BLOCKED',
  message: 'Source request blocked',
  retryable: false,
}
const failed: ImportJob = {
  ...partial,
  id: 'job-failed',
  state: 'failed',
  counts: { ...queued.counts },
  sources: [
    {
      sourceId: 'fixture',
      state: 'failed',
      coverage: 'partial',
      error: failure,
    },
  ],
  reasons: ['SOURCE_BLOCKED'],
  error: failure,
}
const restarted: ImportJob = {
  ...queued,
  state: 'running',
  stage: 'discovering',
  startedAt: '2026-10-15T00:01:01Z',
  budget: { ...queued.budget, discoveryUsed: 1 },
  sources: [
    { sourceId: 'fixture', state: 'running', coverage: 'partial', error: null },
  ],
  reasons: ['CURSOR_EXPIRED'],
  continuation: {
    ...queued.continuation,
    restarted: true,
    restartReason: 'CURSOR_EXPIRED',
  },
}
const continuedRequest: ImportRequest = {
  id: 'request-2',
  area: queued.area,
  intent: 'continue',
  state: 'queued',
  disposition: 'continued',
  jobIds: [queued.id],
  pendingFollowUp: false,
  createdAt: queued.createdAt,
  finishedAt: null,
  error: null,
}
const partialRequest: ImportRequest = {
  ...continuedRequest,
  id: 'request-1',
  intent: 'import',
  state: 'partial',
  disposition: 'created',
  jobIds: [partial.id],
  createdAt: partial.createdAt,
  finishedAt: partial.finishedAt,
}
export const continuationFixtures = {
  queued,
  partial,
  cancelled,
  failed,
  restarted,
  continuedRequest,
  partialRequest,
}
