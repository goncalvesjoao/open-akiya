import type { BrowserContext } from '@playwright/test'

// A fixed image exercises successful Leaflet tile loading without public traffic.
const tile = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
)
export async function controlledTiles(context: BrowserContext) {
  await context.route('https://**/*', (route) => {
    const url = new URL(route.request().url())
    return url.hostname === 'tile.openstreetmap.org' ||
      url.hostname.endsWith('.tile.openstreetmap.org')
      ? route.fulfill({ status: 200, contentType: 'image/png', body: tile })
      : route.abort()
  })
}
