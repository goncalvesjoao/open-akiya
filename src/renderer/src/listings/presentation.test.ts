import { expect, test } from 'vitest'
import { unknownFixtures } from '../../../main/fixtures'
import { listingTitle } from './presentation'

test('labels the precise outside sample by its source identity after import', () => {
  const fixture = unknownFixtures.find(
    (listing) => listing.id === 'sample-precise-outside-1',
  )
  if (!fixture) throw new Error('Missing precise outside sample fixture')

  expect(listingTitle({ ...fixture, id: 'persisted-listing-identity' })).toBe(
    'Precise-location sample listing outside the discovery area',
  )
})
