import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import AreaMap from './AreaMap'
import { municipalityFixtures } from '../../main/fixtures'
import { initialArea } from '../../shared/geography'
import type { AreaResults } from '../../shared/listings'

afterEach(cleanup)

test('keeps municipality offers in expandable groups without duplicate rows or fabricated house distances', async () => {
  const listings = municipalityFixtures
    .slice(0, 3)
    .filter((listing) => listing.availability !== 'unavailable')
  const result: AreaResults = {
    area: initialArea,
    showUnavailable: false,
    mode: 'synthetic',
    listings,
    municipalityGroups: listings.map((listing, index) => ({
      municipalityId: listing.municipalityId!,
      nameJa: 'サンプル自治体',
      listingIds: [listing.id],
      count: 1,
      representativePoint:
        index === 0 ? { latitude: 35.1, longitude: 135 } : null,
      representativePointProvenance:
        index === 0 ? 'Synthetic municipal office' : null,
    })),
    coverage: {
      status: 'unknown',
      lastSuccessfulCheckAt: null,
      freshUntil: null,
      scopeKey: null,
      caveats: [],
    },
    generatedAt: '2026-10-15T00:00:00Z',
  }
  Object.defineProperty(window, 'openAkiya', {
    configurable: true,
    value: {
      areaResults: vi.fn(async () => result),
      listImports: vi.fn(async () => ({ jobs: [] })),
    },
  })
  render(<AreaMap />)
  expect(
    await screen.findByRole('button', {
      name: 'Municipality summary: Sample municipality · 1 listing',
    }),
  ).toBeVisible()
  const group = await screen.findByRole('group', {
    name: 'Municipality summary: Sample municipality without a point',
  })
  expect(
    within(group).getByText(/No documented representative point/),
  ).toBeVisible()
  fireEvent.click(
    within(group).getByText('Sample municipality without a point · 1 listing'),
  )
  fireEvent.click(
    within(group).getByRole('button', {
      name: 'Municipality sample listing without a point',
    }),
  )
  const details = screen.getByRole('region', { name: 'Listing details' })
  expect(details).toHaveTextContent(
    'Exact listing location and distance are unknown',
  )
  expect(
    within(screen.getByRole('list', { name: 'Listing results' })).getAllByRole(
      'button',
      { name: 'Municipality sample listing without a point' },
    ),
  ).toHaveLength(1)
  expect(within(group).queryByText(/\d+\.\d+ km/)).toBeNull()
})

test('retries rejected queries without changing the accepted selection', async () => {
  const { fixtures } = await import('../../main/fixtures')
  const result: AreaResults = {
    area: initialArea,
    showUnavailable: false,
    mode: 'synthetic',
    listings: [fixtures[0]],
    municipalityGroups: [],
    coverage: {
      status: 'unknown',
      lastSuccessfulCheckAt: null,
      freshUntil: null,
      scopeKey: null,
      caveats: [],
    },
    generatedAt: '2026-10-15T00:00:00Z',
  }
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(result)
  Object.defineProperty(window, 'openAkiya', {
    configurable: true,
    value: { areaResults: query, listImports: () => new Promise(() => {}) },
  })
  render(<AreaMap />)
  expect(await screen.findByText(/Listing query failed/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Retry listing query' }))
  expect(await screen.findByText(/1 synthetic listings/)).toBeVisible()
  expect(screen.getByText('Selected: 35, 135 · 5 km')).toBeVisible()
})

test('hides previous-area results while loading and ignores late responses after a newer empty result', async () => {
  const { fixtures } = await import('../../main/fixtures')
  const result: AreaResults = {
    area: initialArea,
    showUnavailable: false,
    mode: 'synthetic',
    listings: [fixtures[0]],
    municipalityGroups: [],
    coverage: {
      status: 'unknown',
      lastSuccessfulCheckAt: null,
      freshUntil: null,
      scopeKey: null,
      caveats: [],
    },
    generatedAt: '2026-10-15T00:00:00Z',
  }
  let resolveOlder!: (value: AreaResults) => void
  const query = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockImplementationOnce(
      () =>
        new Promise<AreaResults>((resolve) => {
          resolveOlder = resolve
        }),
    )
    .mockImplementationOnce(async (input) => ({
      ...result,
      ...input,
      listings: [],
    }))
  Object.defineProperty(window, 'openAkiya', {
    configurable: true,
    value: { areaResults: query, listImports: () => new Promise(() => {}) },
  })
  render(<AreaMap />)
  await screen.findByText(/1 synthetic listings/)
  fireEvent.change(screen.getByLabelText('Latitude'), {
    target: { value: '34' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply area' }))
  expect(screen.getByText('Loading listings…')).toBeVisible()
  expect(
    within(screen.getByRole('list', { name: 'Listing results' })).queryByRole(
      'button',
    ),
  ).toBeNull()
  fireEvent.change(screen.getByLabelText('Latitude'), {
    target: { value: '33' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply area' }))
  await screen.findByText(/No listings in this selected area/)
  const { act } = await import('@testing-library/react')
  await act(async () =>
    resolveOlder({
      ...result,
      area: { ...initialArea, center: { latitude: 34, longitude: 135 } },
    }),
  )
  expect(screen.getByText('Selected: 33, 135 · 5 km')).toBeVisible()
  expect(screen.getByText(/No listings in this selected area/)).toBeVisible()
  expect(
    within(screen.getByRole('list', { name: 'Listing results' })).queryByRole(
      'button',
    ),
  ).toBeNull()
})

test('keeps selected details and truthful coverage when refreshing saved results fails', async () => {
  const { fixtures } = await import('../../main/fixtures')
  const result: AreaResults = {
    area: initialArea,
    showUnavailable: false,
    mode: 'synthetic',
    listings: [fixtures[0]],
    municipalityGroups: [],
    coverage: {
      status: 'partial',
      lastSuccessfulCheckAt: '2026-10-14T00:00:00Z',
      freshUntil: null,
      scopeKey: null,
      caveats: ['Configured synthetic sources only'],
    },
    generatedAt: '2026-10-15T00:00:00Z',
  }
  let refresh!: () => void
  const query = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockRejectedValue(new Error('offline'))
  Object.defineProperty(window, 'openAkiya', {
    configurable: true,
    value: {
      areaResults: query,
      listImports: () =>
        new Promise((resolve) => {
          refresh = () => resolve({ jobs: [] })
        }),
    },
  })
  render(<AreaMap />)
  await screen.findByText(/1 synthetic listings/)
  fireEvent.click(
    within(screen.getByRole('list', { name: 'Listing results' })).getByRole(
      'button',
    ),
  )
  const before = screen.getByRole('region', {
    name: 'Listing details',
  }).textContent
  const { act } = await import('@testing-library/react')
  await act(async () => refresh())
  expect(await screen.findByText(/Listing query failed/)).toBeVisible()
  expect(
    screen.getByRole('region', { name: 'Listing details' }).textContent,
  ).toBe(before)
  expect(screen.getByText(/Coverage partial/)).toHaveTextContent(
    '2026-10-14T00:00:00Z',
  )
  expect(screen.getByText('Configured synthetic sources only')).toBeVisible()
})
