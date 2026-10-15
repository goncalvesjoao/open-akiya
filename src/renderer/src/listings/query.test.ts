import { expect, test } from 'vitest'
import { safeSourceUrl } from './query'

test.each(['http', 'https'])(
  'allows %s links on the configured source host',
  (scheme) => {
    const url = `${scheme}://example.invalid/offers/sale-1`
    expect(safeSourceUrl('fixture', url)).toBe(url)
  },
)

test.each([
  ['fixture', 'javascript:alert(1)'],
  ['fixture', 'ftp://example.invalid/offers/sale-1'],
  ['fixture', 'https://other.invalid/offers/sale-1'],
  ['fixture', 'https://example.invalid.attacker.invalid/offers/sale-1'],
  ['fixture', 'https://user:pass@example.invalid/offers/sale-1'],
  ['fixture', 'https://user@example.invalid/offers/sale-1'],
  ['fixture', 'https://:pass@example.invalid/offers/sale-1'],
  ['fixture', 'not a URL'],
  ['unknown-source', 'https://example.invalid/offers/sale-1'],
])('rejects unsafe or unconfigured source URL %s %s', (sourceId, url) => {
  expect(safeSourceUrl(sourceId, url)).toBeNull()
})
