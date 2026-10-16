import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import AreaMap from './AreaMap'
import {
  fixtures,
  municipalityFixtures,
  uncertainFixtures,
  unknownFixtures,
} from '../../main/fixtures'
import { initialArea } from '../../shared/geography'
import { listingTitle } from './listings/presentation'
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

function savedResults(
  coverage: Partial<AreaResults['coverage']> = {},
): AreaResults {
  return {
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
      ...coverage,
    },
    generatedAt: '2026-10-15T00:00:00Z',
  }
}

test('retries rejected queries without changing the accepted selection', async () => {
  const result = savedResults()
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
  const result = savedResults()
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
  const result = savedResults({
    status: 'partial',
    lastSuccessfulCheckAt: '2026-10-14T00:00:00Z',
    caveats: ['Configured synthetic sources only'],
  })
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

// Query membership is covered at the worker seam; these cases exercise rendering
// and selection against controlled public API responses.
test.each([
  {
    name: 'unknown location',
    offers: unknownFixtures.slice(0, 2),
    list: 'Unknown location',
    title: 'Unknown-location sample listing',
    caveat: 'Exact location and distance unknown',
    japanese: '所在地不明のサンプル',
  },
  {
    name: 'unverified source point',
    offers: [uncertainFixtures[0], uncertainFixtures[2]],
    list: 'Listing results',
    title: 'Unverified sample listing',
    caveat: 'Source position; accuracy unknown',
    japanese: '位置未確認サンプル',
  },
  {
    name: 'approximate source point',
    offers: [uncertainFixtures[1], uncertainFixtures[2]],
    list: 'Listing results',
    title: 'Approximate sample listing',
    caveat: 'Approximate source position',
    japanese: '概略位置サンプル',
  },
  {
    name: 'municipality',
    offers: municipalityFixtures.slice(0, 2),
    list: 'Offers in Sample municipality',
    title: 'Municipality sample listing',
    caveat: 'Exact listing location and distance are unknown',
    japanese: '自治体のみのサンプル',
  },
])(
  'renders $name details and clears selection when filtering or changing area',
  async ({ offers, list, title, caveat, japanese }) => {
    Object.defineProperty(window, 'openAkiya', {
      configurable: true,
      value: {
        listImports: () => new Promise(() => {}),
        areaResults: vi.fn(async (query) => {
          const listings =
            query.area.center.latitude === 35
              ? offers.filter(
                  (offer) =>
                    query.showUnavailable ||
                    offer.availability !== 'unavailable',
                )
              : []
          return {
            ...savedResults(),
            ...query,
            listings,
            municipalityGroups:
              list.startsWith('Offers') && listings.length
                ? [
                    {
                      municipalityId: 'fixture:municipality-1',
                      nameJa: 'サンプル自治体',
                      listingIds: listings.map((offer) => offer.id),
                      count: listings.length,
                      representativePoint: null,
                      representativePointProvenance: null,
                    },
                  ]
                : [],
          }
        }),
      },
    })
    render(<AreaMap />)
    if (list.startsWith('Offers')) {
      fireEvent.click(
        await screen.findByText('Sample municipality · 1 listing'),
      )
    }
    const results = await screen.findByRole('list', { name: list })
    const button = await within(results).findByRole('button', {
      name: title,
    })
    expect(results).not.toHaveTextContent(/\d+\.\d+ km/)
    if (!list.startsWith('Offers')) expect(results).toHaveTextContent(caveat)
    if (list === 'Unknown location')
      expect(
        within(
          screen.getByRole('list', { name: 'Listing results' }),
        ).queryByRole('button', { name: title }),
      ).toBeNull()
    fireEvent.click(button)
    const details = screen.getByRole('region', { name: 'Listing details' })
    expect(details).toHaveTextContent(caveat)
    const disclosure = within(details).getByText(
      'Original Japanese source text',
    )
    fireEvent.click(disclosure)
    expect(disclosure.closest('details')).toHaveAttribute('open')
    expect(within(details).getByText(japanese)).toBeVisible()
    expect(
      within(details).getByRole('link', { name: 'Original source ↗' }),
    ).toHaveAttribute('href', offers[0].sourceRefs[0].url)
    fireEvent.click(screen.getByLabelText('Show unavailable'))
    if (list.startsWith('Offers'))
      await screen.findByText('Sample municipality · 2 listings')
    const unavailable = offers.find(
      (offer) => offer.availability === 'unavailable',
    )!
    fireEvent.click(
      await within(await screen.findByRole('list', { name: list })).findByRole(
        'button',
        {
          name: listingTitle(unavailable),
        },
      ),
    )
    expect(
      screen.getByRole('region', { name: 'Listing details' }),
    ).toHaveTextContent('Availability: unavailable')
    fireEvent.click(screen.getByLabelText('Show unavailable'))
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Listing details' }),
      ).toBeNull(),
    )
    fireEvent.click(
      await within(await screen.findByRole('list', { name: list })).findByRole(
        'button',
        { name: title },
      ),
    )
    fireEvent.change(screen.getByLabelText('Latitude'), {
      target: { value: '34' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply area' }))
    await screen.findByText(/No listings in this selected area/)
    expect(screen.queryByRole('region', { name: 'Listing details' })).toBeNull()
  },
)
