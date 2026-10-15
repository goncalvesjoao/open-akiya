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
