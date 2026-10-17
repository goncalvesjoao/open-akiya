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
  localStorage.clear()
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
    'Reconnecting to import worker',
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

test.each(['pending follow-up', 'running shared job'])(
  'stops settled inspections while retaining history and following %s',
  async (reason) => {
    vi.useFakeTimers()
    try {
      let finished = false
      const api = setup({
        createImportRequest: vi.fn(async () => cachedImportRequest),
        inspectImportRequest: vi.fn(async () => ({
          ...cachedImportRequest,
          pendingFollowUp: reason === 'pending follow-up' && !finished,
        })),
        inspectImport: vi.fn(async () =>
          reason === 'running shared job' && !finished
            ? job
            : succeededImportJob,
        ),
      })
      const settled = vi.fn()
      await act(async () => {
        render(<ImportControls area={initialArea} onSettled={settled} />)
      })
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Import sample listings' }),
        )
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(api.inspectImportRequest).toHaveBeenCalledTimes(2)
      finished = true
      settled.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(api.inspectImportRequest).toHaveBeenCalledTimes(3)
      expect(screen.getByText(/Request accepted.*cached/)).toBeVisible()
      expect(
        screen.getByRole('list', { name: 'Import queue' }),
      ).toHaveTextContent('Search finished')
      if (reason === 'running shared job') expect(settled).toHaveBeenCalled()
      const jobReads = vi.mocked(api.inspectImport).mock.calls.length
      const queueReads = vi.mocked(api.listImports).mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(api.inspectImportRequest).toHaveBeenCalledTimes(3)
      expect(api.inspectImport).toHaveBeenCalledTimes(jobReads)
      expect(vi.mocked(api.listImports).mock.calls.length).toBeGreaterThan(
        queueReads,
      )
      api.createImportRequest = vi.fn(async () => ({
        ...queuedImportRequest,
        id: 'new-request',
      }))
      api.inspectImportRequest = vi.fn(async () => ({
        ...queuedImportRequest,
        id: 'new-request',
      }))
      api.listImports = vi.fn(async () => ({
        jobs: [{ ...job, id: 'new-job' }],
      }))
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Import sample listings' }),
        )
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(api.inspectImportRequest).toHaveBeenCalledWith('new-request')
      expect(
        screen.getByRole('list', { name: 'Import queue' }),
      ).toHaveTextContent('running')
      expect(
        screen.getByRole('list', { name: 'Import queue' }),
      ).toHaveTextContent('Search finished')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  },
)

test('reload recovers the same request and terminal linked job without submitting again', async () => {
  const api = setup({
    inspectImportRequest: vi.fn(async () => cachedImportRequest),
    inspectImport: vi.fn(async () => succeededImportJob),
  })
  const first = render(
    <ImportControls area={initialArea} onSettled={() => {}} />,
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  await screen.findByText(/Request accepted/)
  first.unmount()
  render(
    <ImportControls
      area={{ ...initialArea, radiusKm: 1 }}
      onSettled={() => {}}
    />,
  )
  await waitFor(() =>
    expect(api.inspectImportRequest).toHaveBeenCalledWith(
      queuedImportRequest.id,
    ),
  )
  expect(await screen.findByText(/Request accepted.*cached/)).toHaveTextContent(
    '5 km',
  )
  expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent(
    'Search finished',
  )
  expect(api.createImportRequest).toHaveBeenCalledTimes(1)
})

test('reconnect retains progress through inspection failure and discovers pending follow-up jobs', async () => {
  vi.useFakeTimers()
  try {
    const { manualRefreshFixtures: fixture } =
      await import('../../shared/manual-refresh-fixtures')
    const api = setup({
      createImportRequest: vi.fn(async () => fixture.attached),
      inspectImportRequest: vi.fn(async () => fixture.attached),
      inspectImport: vi.fn(async () => fixture.ordinary),
    })
    const first = render(
      <ImportControls area={initialArea} onSettled={() => {}} />,
    )
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Import sample listings' }),
      )
    })
    first.unmount()
    const settled = vi.fn()
    await act(async () => {
      render(<ImportControls area={initialArea} onSettled={settled} />)
    })
    expect(screen.getByText(/Follow-up pending/)).toBeVisible()
    expect(
      screen.getByRole('list', { name: 'Import queue' }),
    ).toHaveTextContent(fixture.ordinary.coverage.lastSuccessfulCheckAt!)
    api.inspectImportRequest = vi.fn(async () => {
      throw new Error('connection lost')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This is not an import failure',
    )
    expect(
      screen.getByRole('list', { name: 'Import queue' }),
    ).toHaveTextContent('1 saved')
    api.inspectImportRequest = vi.fn(async () => fixture.pending)
    api.inspectImport = vi.fn(async (id) =>
      id === fixture.ordinary.id ? fixture.ordinary : fixture.queued,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect imports' }))
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.inspectImport).toHaveBeenCalledWith(fixture.queued.id)
    expect(screen.getByText(/Follow-up pending/)).toBeVisible()
    api.inspectImportRequest = vi.fn(async () => fixture.completed)
    api.inspectImport = vi.fn(async (id) =>
      id === fixture.ordinary.id ? fixture.ordinary : fixture.succeeded,
    )
    settled.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.queryByText(/Follow-up pending/)).toBeNull()
    expect(
      screen.getByRole('list', { name: 'Import queue' }),
    ).toHaveTextContent('1 updated')
    expect(settled).toHaveBeenCalled()
    expect(api.createImportRequest).toHaveBeenCalledTimes(1)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test.each(['cancelled', 'failed'] as const)(
  'reload inspects %s work without resuming or reopening it',
  async (state) => {
    const terminal = { ...cachedImportRequest, state }
    const api = setup({
      createImportRequest: vi.fn(async () => terminal),
      inspectImportRequest: vi.fn(async () => terminal),
      inspectImport: vi.fn(async () => ({ ...succeededImportJob, state })),
    })
    const first = render(
      <ImportControls area={initialArea} onSettled={() => {}} />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Import sample listings' }),
    )
    await screen.findByText(/Request accepted/)
    first.unmount()
    render(<ImportControls area={initialArea} onSettled={() => {}} />)
    expect(
      await screen.findByText(new RegExp('Request accepted.*' + state)),
    ).toBeVisible()
    expect(api.createImportRequest).toHaveBeenCalledTimes(1)
    expect(api.cancelImport).not.toHaveBeenCalled()
  },
)

test('one unavailable request does not hide other recovered work or prevent new imports', async () => {
  localStorage.setItem(
    'import-request-ids',
    JSON.stringify(['missing', queuedImportRequest.id]),
  )
  const api = setup({
    inspectImportRequest: vi.fn(async (id) => {
      if (id === 'missing') throw new Error('not found')
      return cachedImportRequest
    }),
    inspectImport: vi.fn(async () => succeededImportJob),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  expect(await screen.findByText(/Request accepted.*cached/)).toBeVisible()
  expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent(
    'Search finished',
  )
  expect(
    screen.getByRole('button', { name: 'Reconnect imports' }),
  ).toBeEnabled()
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  await waitFor(() => expect(api.createImportRequest).toHaveBeenCalledTimes(1))
})
