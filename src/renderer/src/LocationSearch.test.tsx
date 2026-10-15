import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import AreaMap from './AreaMap'
import type { LocationSearchResults } from '../../shared/location-search'

afterEach(cleanup)
function setup(
  searchLocations = vi
    .fn<(query: string) => Promise<LocationSearchResults>>()
    .mockResolvedValue({
      matches: [
        {
          label: '京都市, 京都府, 日本',
          center: { latitude: 35.01, longitude: 135.76 },
        },
      ],
      attribution: '© OpenStreetMap contributors · ODbL',
    }),
) {
  const areaResults = vi.fn(async (query) => ({
    ...query,
    mode: 'synthetic',
    listings: [],
    municipalityGroups: [],
    coverage: { status: 'unknown' },
    generatedAt: '',
  }))
  const createImportRequest = vi.fn()
  Object.defineProperty(window, 'openAkiya', {
    configurable: true,
    value: {
      searchLocations,
      areaResults,
      listImports: async () => ({ jobs: [] }),
      createImportRequest,
    },
  })
  render(<AreaMap />)
  return { searchLocations, areaResults, createImportRequest }
}
function submit(query: string) {
  fireEvent.change(screen.getByLabelText('Japanese address or place'), {
    target: { value: query },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Search places' }))
}
test('requires an explicit match choice, preserving radius and unavailable setting without import', async () => {
  const api = setup()
  fireEvent.change(screen.getByLabelText('Radius (km)'), {
    target: { value: '7' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply area' }))
  fireEvent.click(screen.getByLabelText('Show unavailable'))
  submit('  京都  ')
  const match = await screen.findByRole('button', {
    name: '京都市, 京都府, 日本',
  })
  expect(api.searchLocations).toHaveBeenCalledWith('京都')
  expect(screen.getByLabelText('Latitude')).toHaveValue('35')
  fireEvent.click(match)
  expect(screen.getByLabelText('Latitude')).toHaveValue('35.01')
  expect(screen.getByLabelText('Longitude')).toHaveValue('135.76')
  expect(screen.getByLabelText('Radius (km)')).toHaveValue('7')
  await waitFor(() =>
    expect(api.areaResults).toHaveBeenLastCalledWith({
      area: { center: { latitude: 35.01, longitude: 135.76 }, radiusKm: 7 },
      showUnavailable: true,
    }),
  )
  expect(api.createImportRequest).not.toHaveBeenCalled()
})

test('distinguishes loading, empty, failure and retry, and rejects blank without transport', async () => {
  const search = vi.fn<(query: string) => Promise<LocationSearchResults>>()
  let finish!: (value: LocationSearchResults) => void
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const api = setup(search)
  submit(' ')
  expect(search).not.toHaveBeenCalled()
  expect(screen.getByText(/Enter an address or place name/)).toBeVisible()
  submit('Tokyo')
  expect(screen.getByText('Searching places…')).toBeVisible()
  finish({ matches: [], attribution: 'OSM' })
  expect(await screen.findByText(/No matching places/)).toBeVisible()
  search.mockRejectedValueOnce(
    Object.assign(new Error(), { code: 'LOCATION_RATE_LIMIT' }),
  )
  submit('Tokyo')
  expect(await screen.findByText(/rate limit reached/)).toBeVisible()
  search.mockRejectedValueOnce(new Error())
  submit('Tokyo')
  expect(await screen.findByText(/Location search unavailable/)).toBeVisible()
  search.mockResolvedValueOnce({
    matches: [{ label: 'Invalid', center: { latitude: NaN, longitude: 135 } }],
    attribution: 'OSM',
  })
  submit('Tokyo')
  expect(await screen.findByText(/invalid response/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Invalid' })).toBeNull()
  expect(screen.getByLabelText('Latitude')).toHaveValue('35')
  expect(api.createImportRequest).not.toHaveBeenCalled()
})

test('invalidates matches on editing and clear and ignores superseded responses and manual selection', async () => {
  const pending: ((value: LocationSearchResults) => void)[] = []
  const search = vi
    .fn<(query: string) => Promise<LocationSearchResults>>()
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve)
        }),
    )
  setup(search)
  submit('Old')
  submit('New')
  pending[1]!({
    matches: [
      { label: 'Current', center: { latitude: 36, longitude: 136 } },
      { label: 'Other', center: { latitude: 37, longitude: 137 } },
    ],
    attribution: 'OSM',
  })
  const current = await screen.findByRole('button', { name: 'Current' })
  expect(current).toHaveAttribute('type', 'button')
  pending[0]!({
    matches: [{ label: 'Old', center: { latitude: 38, longitude: 138 } }],
    attribution: 'OSM',
  })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Old' })).toBeNull(),
  )
  fireEvent.change(screen.getByLabelText('Japanese address or place'), {
    target: { value: 'Edited' },
  })
  expect(screen.queryByRole('button', { name: 'Current' })).toBeNull()
  submit('Manual')
  fireEvent.click(screen.getByRole('button', { name: 'Apply area' }))
  await act(async () => {
    pending[2]!({
      matches: [{ label: 'Late', center: { latitude: 39, longitude: 139 } }],
      attribution: 'OSM',
    })
  })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Late' })).toBeNull(),
  )
  submit('Dismissed')
  fireEvent.click(screen.getByRole('button', { name: 'Clear place search' }))
  pending[3]!({
    matches: [{ label: 'Dismissed', center: { latitude: 39, longitude: 139 } }],
    attribution: 'OSM',
  })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Dismissed' })).toBeNull(),
  )
})

test('manual map choice invalidates an outstanding lookup while preserving the chosen area', async () => {
  let finish!: (value: LocationSearchResults) => void
  setup(
    vi
      .fn<(query: string) => Promise<LocationSearchResults>>()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
  )
  submit('Delayed')
  fireEvent.click(
    screen.getByRole('region', { name: 'Interactive synthetic map' }),
    { clientX: 100, clientY: 100 },
  )
  const chosen = screen.getByLabelText('Latitude').getAttribute('value')
  expect(chosen).not.toBe('35')
  await act(async () => {
    finish({
      matches: [
        { label: 'Delayed match', center: { latitude: 39, longitude: 139 } },
      ],
      attribution: 'OSM',
    })
  })
  expect(screen.queryByRole('button', { name: 'Delayed match' })).toBeNull()
  expect(screen.getByLabelText('Latitude')).toHaveValue(chosen)
})
