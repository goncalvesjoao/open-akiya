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
import type { DesktopAPI, Job } from '../../shared/desktop'

const job: Job = {
  id: 'fixture-job',
  area: initialArea,
  state: 'running',
  stage: 'discovering',
  createdAt: '2026-10-15T00:00:00Z',
  startedAt: '2026-10-15T00:00:01Z',
  finishedAt: null,
  processed: 0,
  added: 0,
  updated: 0,
  error: null,
}
function setup(overrides: Partial<DesktopAPI> = {}) {
  const api: DesktopAPI = {
    createImport: vi.fn(async () => job),
    inspectImport: vi.fn(async () => job),
    cancelImport: vi.fn(async (): Promise<Job> => ({
      ...job,
      state: 'cancelled',
    })),
    listImports: vi.fn(async () => []),
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
  expect(api.createImport).not.toHaveBeenCalled()
  api.listImports = vi.fn(async () => [job])
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  await waitFor(() =>
    expect(api.createImport).toHaveBeenCalledWith({
      area: initialArea,
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
  expect(api.createImport).toHaveBeenCalledTimes(1)
})

test('cancels visible work and refreshes saved results without deleting data', async () => {
  const api = setup({ listImports: vi.fn(async () => [job]) })
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
