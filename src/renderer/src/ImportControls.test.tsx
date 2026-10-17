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
      expect(
        JSON.parse(localStorage.getItem('open-akiya.import-request-ids')!),
      ).toEqual([cachedImportRequest.id])
      finished = true
      settled.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(api.inspectImportRequest).toHaveBeenCalledTimes(3)
      expect(
        JSON.parse(localStorage.getItem('open-akiya.import-request-ids')!),
      ).toEqual([])
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
    cancelImportRequest: vi.fn(async () => manualRefreshFixtures.cancelled),
    listImports: vi.fn(async () => ({ jobs: [job] })),
  })
  render(<ImportControls area={initialArea} onSettled={() => {}} />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Import sample listings' }),
  )
  await screen.findByRole('button', { name: 'Cancel request intent' })
  expect(
    screen.getByRole('list', { name: 'Your import requests' }),
  ).toHaveTextContent('Follow-up pending')
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
    'open-akiya.import-request-ids',
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
  expect(
    JSON.parse(localStorage.getItem('open-akiya.import-request-ids')!),
  ).toEqual([queuedImportRequest.id])
  expect(api.createImportRequest).not.toHaveBeenCalled()
})

test('retains reconnect IDs on transient inspection failure and retries them', async () => {
  vi.useFakeTimers()
  try {
    localStorage.setItem(
      'open-akiya.import-request-ids',
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
      'Import worker unavailable',
    )
    expect(
      JSON.parse(localStorage.getItem('open-akiya.import-request-ids')!),
    ).toEqual([queuedImportRequest.id])
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
