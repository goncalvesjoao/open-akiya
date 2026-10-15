import { expect, test, vi } from 'vitest'
import { createLocationSearch } from './location-search'

test('searches Japan with trimmed Japanese input and returns bounded labeled valid matches', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify([
          {
            display_name: '京都市, 京都府, 日本',
            lat: '35.01',
            lon: '135.76',
            address: { country_code: 'jp' },
          },
          {
            display_name: 'Invalid',
            lat: 'NaN',
            lon: '135',
            address: { country_code: 'jp' },
          },
        ]),
      ),
  )
  const search = createLocationSearch('http://127.0.0.1:8080/search', fetcher)
  expect(await search(' 京都 ')).toEqual({
    matches: [
      {
        label: '京都市, 京都府, 日本',
        center: { latitude: 35.01, longitude: 135.76 },
      },
    ],
    attribution: '© OpenStreetMap contributors · ODbL',
  })
  const url = new URL(String(fetcher.mock.calls[0]![0]))
  expect(url.searchParams.get('q')).toBe('京都')
  expect(url.searchParams.get('countrycodes')).toBe('jp')
  expect(url.searchParams.get('limit')).toBe('5')
})

test('rejects blank or malformed IPC inputs and missing configuration without transport', async () => {
  const fetcher = vi.fn()
  const search = createLocationSearch(undefined, fetcher)
  for (const query of ['', '  ', {}, 'x'.repeat(301)])
    await expect(search(query)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  await expect(search('Tokyo')).rejects.toMatchObject({
    code: 'LOCATION_UNAVAILABLE',
  })
  expect(fetcher).not.toHaveBeenCalled()
})

test('caches results and bounds rate-limit failures without exposing provider errors', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]'))
  const search = createLocationSearch('http://localhost:8080/search', fetcher)
  await search('Tokyo')
  await expect(search(' Tokyo ')).resolves.toMatchObject({ matches: [] })
  await expect(search('Kyoto')).rejects.toMatchObject({
    code: 'LOCATION_RATE_LIMIT',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
  const limited = createLocationSearch(
    'http://localhost:8080/search',
    async () => new Response('private', { status: 429 }),
  )
  await expect(limited('Kyoto')).rejects.toMatchObject({
    code: 'LOCATION_RATE_LIMIT',
  })
  const broken = createLocationSearch(
    'http://localhost:8080/search',
    async () => {
      throw new Error('secret')
    },
  )
  await expect(broken('Kyoto')).rejects.toMatchObject({
    message:
      'Location provider unavailable. Retry or use the map and coordinate controls.',
  })
})

test('blocks public OSMF and credential-bearing or insecure remote endpoints', async () => {
  const fetcher = vi.fn()
  for (const endpoint of [
    'https://nominatim.openstreetmap.org/search',
    'http://remote.test/search',
    'https://secret@remote.test/search',
  ])
    await expect(
      createLocationSearch(endpoint, fetcher)('Kyoto'),
    ).rejects.toMatchObject({ code: 'LOCATION_UNAVAILABLE' })
  expect(fetcher).not.toHaveBeenCalled()
})

test('honors provider Retry-After dates before allowing a retry', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'))
  try {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 429,
          headers: { 'Retry-After': 'Fri, 16 Oct 2026 00:01:00 GMT' },
        }),
      )
      .mockResolvedValue(new Response('[]'))
    const search = createLocationSearch('http://localhost:8080/search', fetcher)
    await expect(search('Kyoto')).rejects.toMatchObject({
      code: 'LOCATION_RATE_LIMIT',
    })
    vi.setSystemTime(new Date('2026-10-16T00:00:59Z'))
    await expect(search('Kyoto')).rejects.toMatchObject({
      code: 'LOCATION_RATE_LIMIT',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-10-16T00:01:00Z'))
    await expect(search('Kyoto')).resolves.toMatchObject({ matches: [] })
  } finally {
    vi.useRealTimers()
  }
})
