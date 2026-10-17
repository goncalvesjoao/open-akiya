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
import {
  cancellationRequestedJob,
  cancelledImportJob,
  cancelledAttachedRequest,
} from '../../shared/cancellation-fixtures'
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
  fireEvent.click(
    await screen.findByRole('button', { name: 'Cancel running job' }),
  )
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
      expect(JSON.parse(localStorage.getItem('import-request-ids')!)).toEqual([
        cachedImportRequest.id,
      ])
      finished = true
      settled.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(api.inspectImportRequest).toHaveBeenCalledTimes(3)
      expect(JSON.parse(localStorage.getItem('import-request-ids')!)).toEqual(
        [],
      )
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

test('retains server queue ordering when a new active job replaces earlier work', async () => {
  vi.useFakeTimers()
  try {
    const { overlappingQueuedImportJob } =
      await import('../../shared/import-fixtures')
    let advanced = false
    setup({
      listImports: vi.fn(async () => ({
        jobs: advanced ? [overlappingQueuedImportJob, job] : [job],
      })),
    })
    await act(async () => {
      render(<ImportControls area={initialArea} onSettled={() => {}} />)
    })
    advanced = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const items = screen
      .getByRole('list', { name: 'Import queue' })
      .querySelectorAll('li')
    expect(items[0]).toHaveTextContent('135.01')
    expect(items[1]).toHaveTextContent('Job area: 35, 135')
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test('distinguishes request intent from shared execution and retains every accepted request', async () => {
  const api = setup({
    createImportRequest: vi
      .fn()
      .mockResolvedValueOnce(queuedImportRequest)
      .mockResolvedValueOnce(attachedImportRequest),
    cancelImportRequest: vi.fn(async () => ({
      ...cancelledAttachedRequest,
      id: queuedImportRequest.id,
    })),
    listImports: vi.fn(async () => ({ jobs: [job] })),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  await screen.findByText(/Request accepted.*created/)
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  await screen.findByText(/Request accepted.*attached/)
  expect(
    screen.getAllByRole('button', { name: 'Cancel request intent' }),
  ).toHaveLength(2)
  await screen.findByRole('button', { name: 'Cancel running job' })
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Cancel request intent' })[0]!,
  )
  await waitFor(() =>
    expect(api.cancelImportRequest).toHaveBeenCalledWith('request'),
  )
  expect(
    await screen.findByRole('list', { name: 'Your import requests' }),
  ).toHaveTextContent('cancelled')
  expect(api.cancelImport).not.toHaveBeenCalled()
  expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent(
    'running',
  )
})

test('shows cancellation requested until returned execution settles and preserves committed counts', async () => {
  const pending = cancellationRequestedJob
  let finished = false
  const api = setup({
    listImports: vi.fn(async () => ({ jobs: finished ? [] : [job] })),
    inspectImport: vi.fn(async () => cancelledImportJob),
    cancelImport: vi.fn(async () => pending),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Cancel running job' }),
  )
  expect(await screen.findByText(/Cancellation requested/)).toBeVisible()
  expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent(
    '1 saved',
  )
  expect(
    screen.getByRole('list', { name: 'Import queue' }),
  ).not.toHaveTextContent('Cancelled')
  expect(api.cancelImportRequest).not.toHaveBeenCalled()
  finished = true
  expect(await screen.findByText('Cancelled')).toBeVisible()
  expect(screen.queryByText(/Cancellation requested/)).toBeNull()
  expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent(
    '1 saved',
  )
})

test('retains the server terminal outcome when cancellation races with completion', async () => {
  setup({
    listImports: vi.fn(async () => ({ jobs: [job] })),
    cancelImport: vi.fn(async () => succeededImportJob),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Cancel running job' }),
  )
  expect(await screen.findByText('Search finished')).toBeVisible()
  expect(screen.queryByText('Cancelled')).toBeNull()
})

test('does not overwrite a confirmed cancellation with an older queue poll', async () => {
  vi.useFakeTimers()
  try {
    let release!: (value: { jobs: Job[] }) => void
    let reads = 0
    setup({
      listImports: vi.fn(async () =>
        ++reads === 1
          ? { jobs: [job] }
          : new Promise<{ jobs: Job[] }>((resolve) => {
              release = resolve
            }),
      ),
      cancelImport: vi.fn(async () => succeededImportJob),
    })
    await act(async () => {
      render(<ImportControls area={initialArea} onSettled={() => {}} />)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Cancel running job' }),
      )
    })
    await act(async () => {
      release({ jobs: [job] })
    })
    expect(screen.getByText('Search finished')).toBeVisible()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test('reconnects accepted request intents after reload without resubmitting work', async () => {
  const api = setup()
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
    await screen.findByRole('button', { name: 'Cancel request intent' }),
  ).toBeVisible()
  expect(api.createImportRequest).toHaveBeenCalledTimes(1)
})

test('cancels a pending follow-up intent using its returned state while shared work stays running', async () => {
  const { manualRefreshFixtures } =
    await import('../../shared/manual-refresh-fixtures')
  const api = setup({
    createImportRequest: vi.fn(async () => manualRefreshFixtures.attached),
    inspectImportRequest: vi.fn(async () => manualRefreshFixtures.attached),
    cancelImportRequest: vi.fn(async () => manualRefreshFixtures.cancelled),
    listImports: vi.fn(async () => ({ jobs: [job] })),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
  await screen.findByRole('button', { name: 'Cancel request intent' })
  expect(
    screen.getByRole('list', { name: 'Your import requests' }),
  ).toHaveTextContent('Follow-up pending')
  await screen.findByRole('button', { name: 'Cancel running job' })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request intent' }))
  await waitFor(() =>
    expect(
      screen.getByRole('list', { name: 'Your import requests' }),
    ).toHaveTextContent('cancelled'),
  )
  expect(
    screen.getByRole('list', { name: 'Your import requests' }),
  ).not.toHaveTextContent('Follow-up pending')
  expect(screen.getByRole('list', { name: 'Import queue' })).toHaveTextContent(
    'running',
  )
  expect(api.cancelImport).not.toHaveBeenCalled()
})

test('keeps cancelled queue entries and remaining accepted work visible after the returned snapshot', async () => {
  const { overlappingQueuedImportJob } =
    await import('../../shared/import-fixtures')
  const { cancelledQueuedImportJob } =
    await import('../../shared/cancellation-fixtures')
  setup({
    listImports: vi.fn(async () => ({
      jobs: [job, overlappingQueuedImportJob],
    })),
    cancelImport: vi.fn(async () => cancelledQueuedImportJob),
  })
  const settled = vi.fn()
  render(<ImportControls area={initialArea} onSettled={settled} />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Cancel queued job' }),
  )
  expect(await screen.findByText('Cancelled')).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Cancel running job' }),
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Cancel queued job' })).toBeNull()
  expect(settled).toHaveBeenCalled()
})

test.each(['job', 'request'])(
  'reports %s cancellation failure without claiming cancellation',
  async (kind) => {
    const reject = async () => {
      throw new Error('private')
    }
    setup({
      listImports: vi.fn(async () => ({ jobs: [job] })),
      cancelImport: vi.fn(reject),
      cancelImportRequest: vi.fn(reject),
    })
    render(<ImportControls area={initialArea} onSettled={() => {}} />)
    if (kind === 'request') {
      fireEvent.click(
        screen.getByRole('button', { name: 'Import sample listings' }),
      )
      fireEvent.click(
        await screen.findByRole('button', { name: 'Cancel request intent' }),
      )
    } else {
      fireEvent.click(
        await screen.findByRole('button', { name: 'Cancel running job' }),
      )
    }
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Inspect its current state before retrying',
    )
    expect(screen.queryByText('Cancelled')).toBeNull()
    expect(screen.queryByText('private')).toBeNull()
  },
)

test('drops missing reconnect IDs without hiding healthy requests and queue work', async () => {
  localStorage.setItem(
    'import-request-ids',
    JSON.stringify(['missing', queuedImportRequest.id]),
  )
  const api = setup({
    listImports: vi.fn(async () => ({ jobs: [job] })),
    inspectImportRequest: vi.fn(async (id) => {
      if (id === 'missing')
        throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
      return queuedImportRequest
    }),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  expect(
    await screen.findByRole('button', { name: 'Cancel request intent' }),
  ).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Cancel running job' }),
  ).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(JSON.parse(localStorage.getItem('import-request-ids')!)).toEqual([
    queuedImportRequest.id,
  ])
  expect(api.createImportRequest).not.toHaveBeenCalled()
})

test('retains reconnect IDs on transient inspection failure and retries them', async () => {
  vi.useFakeTimers()
  try {
    localStorage.setItem(
      'import-request-ids',
      JSON.stringify([queuedImportRequest.id]),
    )
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unavailable'), { code: 'TRANSPORT_ERROR' }),
      )
      .mockResolvedValue(queuedImportRequest)
    setup({ inspectImportRequest: inspect })
    await act(async () => {
      render(<ImportControls area={initialArea} onSettled={() => {}} />)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Reconnecting to import worker',
    )
    expect(JSON.parse(localStorage.getItem('import-request-ids')!)).toEqual([
      queuedImportRequest.id,
    ])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(
      screen.getByRole('button', { name: 'Cancel request intent' }),
    ).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(inspect).toHaveBeenCalledWith(queuedImportRequest.id)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

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
    expect(screen.getByRole('status')).toBeVisible()
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
    expect(screen.getByRole('status')).toBeVisible()
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

test('submits explicit manual refresh intent and consumes repeated server attachment outcomes', async () => {
  const { manualRefreshFixtures: refresh } =
    await import('../../shared/manual-refresh-fixtures')
  const api = setup({
    createImportRequest: vi.fn(async () => refresh.attached),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
  await screen.findByText(/Request accepted.*attached/)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
  await waitFor(() => expect(api.createImportRequest).toHaveBeenCalledTimes(2))
  const calls = vi.mocked(api.createImportRequest).mock.calls
  expect(calls[0]![0]).toEqual({
    area: initialArea,
    intent: 'manual_refresh',
    idempotencyKey: expect.any(String),
  })
  expect(calls[1]![0].idempotencyKey).not.toBe(calls[0]![0].idempotencyKey)
  expect(
    screen.getByRole('list', { name: 'Your import requests' }),
  ).toHaveTextContent('Follow-up pending')
})

test('keeps refresh pending through ordinary success and queued follow-up until final settlement', async () => {
  const { manualRefreshFixtures: refresh } =
    await import('../../shared/manual-refresh-fixtures')
  vi.useFakeTimers()
  try {
    let phase: 'attached' | 'pending' | 'completed' = 'attached'
    setup({
      createImportRequest: vi.fn(async () => refresh.attached),
      inspectImportRequest: vi.fn(async () => refresh[phase]),
      inspectImport: vi.fn(async (id) =>
        id === refresh.ordinary.id
          ? refresh.ordinary
          : phase === 'completed'
            ? refresh.succeeded
            : refresh.queued,
      ),
    })
    const settled = vi.fn()
    await act(async () => {
      render(<ImportControls area={initialArea} onSettled={settled} />)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
    })
    phase = 'pending'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(
      screen.getByRole('list', { name: 'Your import requests' }),
    ).toHaveTextContent('Refresh pending')
    expect(screen.queryByText('Refresh succeeded')).toBeNull()
    expect(
      screen.getByRole('list', { name: 'Import queue' }),
    ).toHaveTextContent('queued')
    expect(
      screen.getByRole('button', { name: 'Cancel queued job' }),
    ).toBeVisible()
    settled.mockClear()
    phase = 'completed'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.getByText('Refresh succeeded')).toBeVisible()
    expect(settled).toHaveBeenCalled()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test.each(['failedRequest', 'exhausted', 'cancelled'] as const)(
  'shows the final refresh %s outcome without success and retains successful job timestamps',
  async (outcome) => {
    const { manualRefreshFixtures: refresh } =
      await import('../../shared/manual-refresh-fixtures')
    const job =
      outcome === 'failedRequest'
        ? refresh.failed
        : outcome === 'exhausted'
          ? refresh.partial
          : refresh.cancelledJob
    setup({
      createImportRequest: vi.fn(async () => refresh[outcome]),
      inspectImportRequest: vi.fn(async () => refresh[outcome]),
      inspectImport: vi.fn(async (id) =>
        id === refresh.ordinary.id ? refresh.ordinary : job,
      ),
    })
    render(<ImportControls area={initialArea} onSettled={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
    expect(
      await screen.findByText(
        /Refresh (failed|incomplete|cancelled).*Saved results retained/,
      ),
    ).toBeVisible()
    expect(screen.queryByText('Refresh succeeded')).toBeNull()
    await waitFor(() =>
      expect(
        screen.getByRole('list', { name: 'Import queue' }),
      ).toHaveTextContent(refresh.ordinary.coverage.lastSuccessfulCheckAt!),
    )
    if (outcome === 'exhausted')
      expect(
        screen.getByText(/Explicit continuation is required/),
      ).toBeVisible()
  },
)

test('retries a lost refresh acknowledgement with its original action key', async () => {
  const { manualRefreshFixtures: refresh } =
    await import('../../shared/manual-refresh-fixtures')
  const keys: string[] = []
  setup({
    createImportRequest: vi.fn(async (input) => {
      keys.push(input.idempotencyKey)
      if (keys.length === 1) throw new Error('lost acknowledgement')
      return refresh.attached
    }),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
  await screen.findByText(/Request accepted.*attached/)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
})

test('cancels queued refresh follow-up execution explicitly', async () => {
  const { manualRefreshFixtures: refresh } =
    await import('../../shared/manual-refresh-fixtures')
  const api = setup({
    createImportRequest: vi.fn(async () => refresh.pending),
    inspectImportRequest: vi.fn(async () => refresh.pending),
    inspectImport: vi.fn(async (id) =>
      id === refresh.ordinary.id ? refresh.ordinary : refresh.queued,
    ),
    cancelImport: vi.fn(async () => refresh.cancelledJob),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'Cancel queued job' }),
  )
  await waitFor(() =>
    expect(api.cancelImport).toHaveBeenCalledWith(refresh.queued.id),
  )
  expect(await screen.findByText('Cancelled')).toBeVisible()
  expect(api.cancelImportRequest).not.toHaveBeenCalled()
})
