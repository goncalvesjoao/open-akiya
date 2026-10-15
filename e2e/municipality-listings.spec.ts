import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Leaflet marker placement, focus and Electron external navigation need a browser.
test('explores municipality summary markers and list-only groups without house pins', async () => {
  // Ten fixture details are paced at two seconds each. Preserve production
  // traffic controls and allow the import to reach these later fixtures.
  test.setTimeout(60000)
  const directory = mkdtempSync(join(tmpdir(), 'akiya-municipality-'))
  const application = await electron.launch({
    args: [
      '--host-resolver-rules=MAP *.tile.openstreetmap.org 127.0.0.1',
      'out/main/index.cjs',
    ],
    env: { ...process.env, OPEN_AKIYA_TEST_DATA: directory },
  })
  await application.context().route('https://**/*', (route) => route.abort())
  const page = await application.firstWindow()
  try {
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    const group = page.getByRole('group', {
      name: 'Municipality summary: Sample municipality',
      exact: true,
    })
    await expect(
      group.getByText('Sample municipality · 2 listings', { exact: true }),
    ).toBeVisible({ timeout: 30000 })
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
      page.getByRole('list', { name: 'Import queue' }).getByRole('listitem'),
    ).toHaveCount(0, { timeout: 30000 })
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
    await page.getByLabel('Show unavailable', { exact: true }).check()
    await expect(
      group.getByText('Sample municipality · 3 listings', { exact: true }),
    ).toBeVisible()
    await group
      .getByRole('button', {
        name: 'Unavailable municipality sample listing',
        exact: true,
      })
      .click()
    await expect(details).toContainText('Availability: unavailable')
    await page.getByLabel('Show unavailable', { exact: true }).uncheck()
    await expect(
      group.getByText('Sample municipality · 2 listings', { exact: true }),
    ).toBeVisible()
    await expect(details).toHaveCount(0)
    const listOnly = page.getByRole('group', {
      name: 'Municipality summary: Sample municipality without a point',
      exact: true,
    })
    await expect(listOnly).toContainText('No documented representative point')
    await listOnly
      .getByText('Sample municipality without a point · 1 listing', {
        exact: true,
      })
      .click()
    await listOnly
      .getByRole('button', {
        name: 'Municipality sample listing without a point',
        exact: true,
      })
      .click()
    await expect(details).toContainText(
      'Municipality sample listing without a point',
    )
    await expect(
      page.getByRole('button', {
        name: /Municipality summary: Sample municipality without a point ·/,
      }),
    ).toHaveCount(0)
    await page.screenshot({
      path: 'test-results/municipality-summary.png',
      fullPage: true,
    })
    // Querying a distant area removes groups, including their representative marker.
    await page.getByLabel('Latitude', { exact: true }).fill('36')
    await page.getByRole('button', { name: 'Apply area' }).click()
    await expect(group).toHaveCount(0)
    await expect(listOnly).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /Municipality summary:/ }),
    ).toHaveCount(0)
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
