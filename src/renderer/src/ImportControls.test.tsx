import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import ImportControls from './ImportControls'
import { initialArea } from './listings/query'
import type { DesktopAPI, Job, ImportRequest } from '../../shared/desktop'

const job: Job = {
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
function setup(overrides: Partial<DesktopAPI> = {}) {
  const api: DesktopAPI = {
    searchLocations: vi.fn(),
    createImportRequest: vi.fn(async (): Promise<ImportRequest> => ({
      id: 'request',
      area: initialArea,
      intent: 'import',
      disposition: 'created',
      state: 'queued',
      jobIds: [job.id],
      pendingFollowUp: false,
      createdAt: job.createdAt,
      finishedAt: null,
      error: null,
    })),
    inspectImportRequest: vi.fn(),
    inspectImport: vi.fn(async () => job),
    cancelImportRequest: vi.fn(),
    cancelImport: vi.fn(async (): Promise<Job> => ({
      ...job,
      state: 'cancelled',
    })),
    listImports: vi.fn(async () => ({ jobs: [] })),
    areaResults: vi.fn(),
    ...overrides,
  }
  vi.stubGlobal('openAkiya', api)
  return api
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('starts only on explicit action and retains immutable job area when selection changes', async () => {
  const api = setup()
  const { rerender } = render(
    <ImportControls area={initialArea} onSettled={() => {}} />,
  )
  await waitFor(() => expect(api.listImports).toHaveBeenCalled())
  expect(api.createImportRequest).not.toHaveBeenCalled()
  api.listImports = vi.fn(async () => ({ jobs: [job] }))
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  await waitFor(() =>
    expect(api.createImportRequest).toHaveBeenCalledWith({
      area: initialArea,
      intent: 'import',
      idempotencyKey: expect.any(String),
    }),
  )
  await screen.findByText(/35, 135/)
  rerender(
    <ImportControls
      area={{ ...initialArea, radiusKm: 1 }}
      onSettled={() => {}}
    />,
  )
  expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent(
    '5 km',
  )
  expect(api.createImportRequest).toHaveBeenCalledTimes(1)
})

test('cancels visible work and refreshes saved results without deleting data', async () => {
  const api = setup({ listImports: vi.fn(async () => ({ jobs: [job] })) })
  const settled = vi.fn()
  render(<ImportControls area={initialArea} onSettled={settled} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel import' }))
  await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith(job.id))
  await waitFor(() => expect(settled).toHaveBeenCalled())
})

test('announces worker failure with a recovery action', async () => {
  setup({
    listImports: vi.fn(async () => {
      throw new Error('private failure')
    }),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Quit and reopen to recover',
  )
  expect(screen.queryByText('private failure')).not.toBeInTheDocument()
})
