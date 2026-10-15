import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This journey requires real Electron to exercise sandboxed preload IPC,
// the utility-process SQLite connection and persisted data after app relaunch.
test('imports the explicitly selected synthetic area and retains saved results after reload and relaunch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-electron-'))
  async function launch() {
    const application = await electron.launch({
      args: [
        '--host-resolver-rules=MAP *.tile.openstreetmap.org 127.0.0.1',
        'out/main/index.cjs',
      ],
      env: { ...process.env, OPEN_AKIYA_TEST_DATA: directory },
    })
    await application.context().route('https://**/*', (route) => route.abort())
    const page = await application.firstWindow()
    return { application, page }
  }
  let session = await launch()
  try {
    await expect(
      session.page.getByRole('heading', { name: 'Open Akiya', exact: true }),
    ).toBeVisible()
    await session.page.getByLabel('Latitude', { exact: true }).fill('35')
    await session.page.getByLabel('Longitude', { exact: true }).fill('135')
    await session.page.getByLabel('Radius (km)', { exact: true }).fill('5')
    await session.page.getByRole('button', { name: 'Apply area' }).click()
    await expect(
      session.page.getByRole('button', {
        name: 'Sample sale listing',
        exact: true,
      }),
    ).toHaveCount(0)
    await session.page
      .getByRole('button', { name: 'Import sample listings' })
      .click()
    const listing = session.page.getByRole('button', {
      name: 'Sample sale listing',
      exact: true,
    })
    await expect(listing).toBeVisible()
    await listing.click()
    await expect(
      session.page.getByRole('region', { name: 'Listing details' }),
    ).toContainText('Free (¥0)')
    await session.page.reload()
    await expect(
      session.page.getByRole('button', {
        name: 'Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    await session.application.close()
    session = await launch()
    await expect(
      session.page.getByRole('button', {
        name: 'Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    const boundary = await session.page.evaluate(() => ({
      methods: Object.keys(window.openAkiya).sort(),
      nodeVisible: 'require' in window || 'process' in window,
    }))
    expect(boundary.nodeVisible).toBe(false)
    expect(boundary.methods).toEqual([
      'areaResults',
      'cancelImport',
      'createImportRequest',
      'inspectImport',
      'inspectImportRequest',
      'listImports',
    ])
  } finally {
    await session.application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
