import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import ImportControls from './ImportControls'
import { initialArea } from './listings/query'
import {
  runningImportJob as job,
  queuedImportRequest,
  succeededImportJob,
  cachedImportRequest,
  attachedImportRequest,
} from '../../shared/import-fixtures'
import type { DesktopAPI, Job, ImportRequest } from '../../shared/desktop'

function setup(overrides: Partial<DesktopAPI> = {}) {
  const api: DesktopAPI = {
    searchLocations: vi.fn(),
    createImportRequest: vi.fn(async (): Promise<ImportRequest> =>
      structuredClone(queuedImportRequest),
    ),
    inspectImportRequest: vi.fn(async () => queuedImportRequest),
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
  await waitFor(() =>
    expect(
      screen.getByRole('list', { name: 'Import queue' }),
    ).toHaveTextContent('5 km'),
  )
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

test('acknowledges a persisted attached request before queue polling completes', async () => {
  setup({
    createImportRequest: vi.fn(async () => attachedImportRequest),
    listImports: vi.fn(() => new Promise<{ jobs: Job[] }>(() => {})),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  expect(await screen.findByText(/Request accepted.*attached/)).toBeVisible()
})

test('keeps the acknowledged request and discovers terminal jobs absent from the active queue', async () => {
  vi.useFakeTimers()
  try {
    setup({
      createImportRequest: vi.fn(async () => cachedImportRequest),
      inspectImportRequest: vi.fn(async () => cachedImportRequest),
      inspectImport: vi.fn(async () => succeededImportJob),
    })
    const settled = vi.fn()
    await act(async () => {
      render(<ImportControls area={initialArea} onSettled={settled} />)
    })
    settled.mockClear()
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Import sample listings' }),
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.getByText(/Request accepted.*cached/)).toBeVisible()
    expect(
      screen.getByRole('list', { name: 'Import queue' }),
    ).toHaveTextContent('Search finished')
    expect(settled).toHaveBeenCalled()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test.each([
  'INVALID_INPUT',
  'NO_ENABLED_SOURCES',
  'UNAUTHORIZED',
  'IDEMPOTENCY_CONFLICT',
])('explains %s rejection without acknowledging success', async (code) => {
  setup({
    createImportRequest: vi.fn(async () => {
      throw Object.assign(new Error('private'), { code })
    }),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(code)
  expect(screen.queryByText(/Request accepted/)).toBeNull()
})

test('retries a lost acknowledgement with the same action key and suppresses double clicks', async () => {
  const keys: string[] = []
  const api = setup({
    createImportRequest: vi.fn(async (input) => {
      keys.push(input.idempotencyKey)
      if (keys.length === 1) throw new Error('connection lost')
      return queuedImportRequest
    }),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  const button = screen.getByRole('button', { name: 'Import sample listings' })
  fireEvent.click(button)
  fireEvent.click(button)
  await screen.findByRole('alert')
  expect(api.createImportRequest).toHaveBeenCalledTimes(1)
  fireEvent.click(button)
  await screen.findByText(/Request accepted/)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
})

test('refreshes saved results for a failed tracked job after it leaves the queue', async () => {
  vi.useFakeTimers()
  try {
    const { failedImportJob } = await import('../../shared/import-fixtures')
    let finished = false
    setup({
      listImports: vi.fn(async () => ({ jobs: finished ? [] : [job] })),
      inspectImport: vi.fn(async () => failedImportJob),
    })
    const settled = vi.fn()
    await act(async () => {
      render(<ImportControls area={initialArea} onSettled={settled} />)
    })
    settled.mockClear()
    finished = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(
      screen.getByRole('list', { name: 'Import queue' }),
    ).toHaveTextContent('Failed')
    expect(settled).toHaveBeenCalledTimes(1)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})
