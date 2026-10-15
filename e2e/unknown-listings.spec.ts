import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The integrated map must retain unknown offers without inventing Leaflet markers.
test('inspects area-associated unknown offers without pins or house distances', async () => {
  // Ten fixture details are paced at two seconds each. Preserve production
  // traffic controls and allow the import to reach these later fixtures.
  test.setTimeout(60000)
  const directory = mkdtempSync(join(tmpdir(), 'akiya-unknown-'))
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
    const unknown = page.getByRole('list', { name: 'Unknown location' })
    await expect(
      unknown.getByRole('button', {
        name: 'Unknown-location sample listing',
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 })
    await expect(unknown).toContainText('Exact location and distance unknown')
    await expect(unknown).not.toContainText(/\d+\.\d+ km/)
    await expect(
      page.getByRole('button', { name: /Pin: .*Unknown-location/ }),
    ).toHaveCount(0)
    await expect(unknown).not.toContainText(
      'Unrelated unknown-location sample listing',
    )
    await expect(
      page.getByRole('list', { name: 'Listing results' }),
    ).not.toContainText('Unknown-location sample listing')
    await unknown
      .getByRole('button', {
        name: 'Unknown-location sample listing',
        exact: true,
      })
      .click()
    const details = page.getByRole('region', { name: 'Listing details' })
    await expect(details).toContainText('Exact location and distance unknown')
    await details
      .getByText('Original Japanese source text', { exact: true })
      .click()
    await expect(
      details.getByText('所在地不明のサンプル', { exact: true }),
    ).toBeVisible()
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
      .toBe('https://example.invalid/offers/location-unknown-1')
    await expect(unknown).not.toContainText(
      'Unavailable unknown-location sample listing',
    )
    await page.getByLabel('Show unavailable', { exact: true }).check()
    await unknown
      .getByRole('button', {
        name: 'Unavailable unknown-location sample listing',
        exact: true,
      })
      .click()
    await expect(details).toContainText('Availability: unavailable')
    await page.getByLabel('Show unavailable', { exact: true }).uncheck()
    await expect(details).toHaveCount(0)
    await page.getByLabel('Latitude', { exact: true }).fill('34')
    await page.getByRole('button', { name: 'Apply area' }).click()
    await expect(unknown.getByRole('button')).toHaveCount(0)
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
