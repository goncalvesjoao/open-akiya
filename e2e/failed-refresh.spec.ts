import { controlledTiles } from './controlled-tiles'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real Electron is necessary to verify failure crosses the independent worker,
// survives reconnect, and refreshes current-area Leaflet results from SQLite.
test('failed refresh retains saved results and successful-check times in the current selection', async () => {
  test.setTimeout(60000)
  const directory = mkdtempSync(join(tmpdir(), 'akiya-failed-refresh-'))
  async function launch(fail = false) {
    const application = await electron.launch({
      args: [
        '--host-resolver-rules=MAP tile.openstreetmap.org 127.0.0.1, MAP *.tile.openstreetmap.org 127.0.0.1',
        'out/main/index.cjs',
      ],
      env: {
        ...process.env,
        OPEN_AKIYA_TEST_HIDDEN: '1',
        OPEN_AKIYA_TEST_DATA: directory,
        OPEN_AKIYA_TEST_SOURCE_FAILURE: fail ? '1' : '',
        OPEN_AKIYA_TEST_IMPORT_PROGRESS: '1',
      },
    })
    await controlledTiles(application.context())
    return { application, page: await application.firstWindow() }
  }
  let session = await launch()
  try {
    await session.page
      .getByRole('button', { name: 'Import sample listings' })
      .click()
    await expect(
      session.page.getByRole('list', { name: 'Import queue' }),
    ).toContainText('Search finished')
    const before = await session.page.evaluate(() =>
      window.openAkiya.areaResults({
        area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
        showUnavailable: false,
      }),
    )
    expect(before.coverage.lastSuccessfulCheckAt).not.toBeNull()
    await session.application.close()
    session = await launch(true)
    await session.page.getByRole('button', { name: 'Refresh anyway' }).click()
    // A terminal refresh must query this current circle, rather than restoring
    // the immutable request circle from the queue.
    await session.page.getByLabel('Radius (km)', { exact: true }).fill('0.01')
    await session.page.getByRole('button', { name: 'Apply area' }).click()
    await expect(
      session.page.getByRole('list', { name: 'Your import requests' }),
    ).toContainText('Refresh failed · Saved results retained.', {
      timeout: 15000,
    })
    await expect(
      session.page.getByRole('list', { name: 'Import queue' }),
    ).toContainText('Synthetic source unavailable')
    await expect(
      session.page.getByLabel('Radius (km)', { exact: true }),
    ).toHaveValue('0.01')
    await expect(
      session.page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      session.page.getByRole('button', {
        name: 'Unverified sample listing',
        exact: true,
      }),
    ).toHaveCount(0)
    const after = await session.page.evaluate(() =>
      window.openAkiya.areaResults({
        area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
        showUnavailable: false,
      }),
    )
    await expect(
      session.page.getByText(/Last successful covering check:/),
    ).toContainText(before.coverage.lastSuccessfulCheckAt!)
    expect(after.listings).toEqual(before.listings)
    expect(after.coverage.lastSuccessfulCheckAt).toBe(
      before.coverage.lastSuccessfulCheckAt,
    )
    expect(after.coverage.freshUntil).toBe(before.coverage.freshUntil)
    await session.page.reload()
    await expect(
      session.page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      session.page.getByRole('list', { name: 'Your import requests' }),
    ).toContainText('Refresh failed · Saved results retained.', {
      timeout: 15000,
    })
  } finally {
    await session.application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
