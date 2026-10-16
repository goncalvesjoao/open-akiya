import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real map markers, overlapping positions and Electron source navigation need a browser.
test('explores uncertain source-point candidates with synchronized pins, results and details', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-uncertain-'))
  const application = await electron.launch({
    args: [
      '--host-resolver-rules=MAP *.tile.openstreetmap.org 127.0.0.1',
      'out/main/index.cjs',
    ],
    env: {
      ...process.env,
      OPEN_AKIYA_TEST_HIDDEN: '1',
      OPEN_AKIYA_TEST_DATA: directory,
    },
  })
  await application.context().route('https://**/*', (route) => route.abort())
  const page = await application.firstWindow()
  try {
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    const results = page.getByRole('list', { name: 'Listing results' })
    const details = page.getByRole('region', { name: 'Listing details' })
    await results
      .getByRole('button', { name: 'Approximate sample listing', exact: true })
      .click()
    const pin = page.getByRole('button', {
      name: 'Pin: Approximate sample listing · Location unverified',
    })
    await page
      .getByRole('button', { name: 'Sample sale listing', exact: true })
      .click()
    await pin.click()
    await expect(
      results.getByRole('button', {
        name: 'Approximate sample listing',
        exact: true,
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(details).toContainText('Approximate sample listing')
    // Both candidates coincide; the companion list retains access to each offer.
    await results
      .getByRole('button', { name: 'Unverified sample listing', exact: true })
      .click()
    await expect(details).toContainText('Unverified sample listing')
    await page.getByLabel('Radius (km)', { exact: true }).fill('0.01')
    await page.getByRole('button', { name: 'Apply area' }).click()
    await expect(results).not.toContainText('Unverified sample listing')
    await expect(results).not.toContainText('Approximate sample listing')
    await expect(
      page.getByRole('button', { name: /Pin: .*Location unverified/ }),
    ).toHaveCount(0)
    await expect(details).toHaveCount(0)
    await expect(
      results.getByRole('button', { name: 'Sample sale listing', exact: true }),
    ).toBeVisible()
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
