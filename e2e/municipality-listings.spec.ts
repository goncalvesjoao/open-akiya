import { controlledTiles } from './controlled-tiles'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Leaflet marker placement, focus and Electron external navigation need a browser.
test('explores municipality summary markers and list-only groups without house pins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-municipality-'))
  const application = await electron.launch({
    args: [
      '--host-resolver-rules=MAP tile.openstreetmap.org 127.0.0.1, MAP *.tile.openstreetmap.org 127.0.0.1',
      'out/main/index.cjs',
    ],
    env: {
      ...process.env,
      OPEN_AKIYA_TEST_HIDDEN: '1',
      OPEN_AKIYA_TEST_DATA: directory,
    },
  })
  await controlledTiles(application.context())
  const page = await application.firstWindow()
  try {
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    const group = page.getByRole('group', {
      name: 'Municipality summary: Sample municipality',
      exact: true,
    })
    await expect(
      group.getByText('Sample municipality · 2 listings', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Zoom out' }).click()
    const pin = page.getByRole('button', {
      name: 'Municipality summary: Sample municipality · 2 listings',
      exact: true,
    })
    await expect(pin).toHaveCSS('border-radius', '5px')
    await expect(pin).toHaveCSS('background-color', 'rgb(99, 66, 124)')
    // Saved offers can appear before the import finishes. Wait for its final
    // query refresh before checking draft edits: that refresh legitimately
    // replaces marker data and is independent of editing coordinate drafts.
    await expect(
      page.getByRole('list', { name: 'Import queue' }),
    ).toContainText('Search finished', { timeout: 30000 })
    await expect(page.getByText('Loading listings…')).toHaveCount(0)
    // Draft edits must preserve real Leaflet markers for subsequent keyboard activation.
    const marker = await pin.elementHandle()
    await pin.focus()
    await page.getByLabel('Latitude', { exact: true }).fill('35.01')
    await expect
      .poll(() => marker!.evaluate((element) => element.isConnected))
      .toBe(true)
    await pin.focus()
    await expect(pin).toBeFocused()
    await page.getByLabel('Latitude', { exact: true }).fill('35')
    await expect
      .poll(() => marker!.evaluate((element) => element.isConnected))
      .toBe(true)
    await pin.press('Enter')
    await expect(group.locator('summary').first()).toBeFocused()
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await expect(group).toContainText(
      'Exact listing locations and distances are unknown',
    )
    await expect(group).toContainText('Synthetic municipal office')
    const sourcePointOffer = group.getByRole('button', {
      name: 'Municipal office source-point sample listing',
      exact: true,
    })
    await sourcePointOffer.click()
    const details = page.getByRole('region', { name: 'Listing details' })
    await expect(details).toContainText(
      'Exact listing location and distance are unknown',
    )
    await expect(
      page.getByRole('button', { name: /Pin: .*municipal/i }),
    ).toHaveCount(0)
    await expect(group.getByRole('button')).toHaveCount(2)
    await application.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        process.env.OPEN_AKIYA_CAPTURED_SOURCE = url
      }
    })
    await details.getByRole('link', { name: 'Original source ↗' }).click()
    await expect
      .poll(() =>
        application.evaluate(() => process.env.OPEN_AKIYA_CAPTURED_SOURCE),
      )
      .toBe('https://example.invalid/offers/municipality-source-point-1')
    await expect(
      page.getByRole('button', { name: /Pin: .*Unknown-location/ }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('list', { name: 'Unknown location' }).getByRole('button', {
        name: 'Unknown-location sample listing',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: /Municipality summary: Sample municipality without a point ·/,
      }),
    ).toHaveCount(0)
    // The municipal office is about 11 km from the selected center, outside
    // its 5 km circle. Membership comes from municipality intersection instead.
    const projection = await page.evaluate(() =>
      window.openAkiya.areaResults({
        area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
        showUnavailable: false,
      }),
    )
    expect(projection.municipalityGroups[0]).toMatchObject({
      count: 2,
      representativePoint: { latitude: 35.1, longitude: 135 },
    })
    expect(new Set(projection.listings.map((listing) => listing.id)).size).toBe(
      projection.listings.length,
    )
    await page.getByLabel('Show unavailable').check()
    await expect(group).toContainText('Sample municipality · 3 listings')
    await expect(
      page.getByRole('button', {
        name: 'Unavailable sample listing',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Pin: Unavailable sample listing',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Unknown location' }),
    ).toContainText('Unavailable unknown-location sample listing')
    await page.getByLabel('Show unavailable').uncheck()
    await expect(group).toContainText('Sample municipality · 2 listings')
    await expect(
      page.getByRole('button', {
        name: 'Unavailable sample listing',
        exact: true,
      }),
    ).toHaveCount(0)
    // Querying a distant area removes groups, including their representative marker.
    await page.getByLabel('Latitude', { exact: true }).fill('36')
    await page.getByRole('button', { name: 'Apply area' }).click()
    await expect(group).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /Municipality summary:/ }),
    ).toHaveCount(0)
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
