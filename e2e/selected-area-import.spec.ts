import { controlledTiles } from './controlled-tiles'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// This journey requires real Electron to exercise sandboxed preload IPC,
// the utility-process SQLite connection and persisted data after app relaunch.
test('imports the explicitly selected synthetic area and retains saved results after reload and relaunch', async () => {
  test.setTimeout(60000)
  const directory = mkdtempSync(join(tmpdir(), 'akiya-electron-'))
  const lookups: string[] = []
  const provider = createServer((request, response) => {
    lookups.push(request.url!)
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify([
        {
          display_name: '京都市, 京都府, 日本',
          lat: '36',
          lon: '136',
          address: { country_code: 'jp' },
        },
      ]),
    )
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/search`
  async function launch() {
    const application = await electron.launch({
      args: [
        '--host-resolver-rules=MAP tile.openstreetmap.org 127.0.0.1, MAP *.tile.openstreetmap.org 127.0.0.1',
        'out/main/index.cjs',
      ],
      env: {
        ...process.env,
        OPEN_AKIYA_TEST_HIDDEN: '1',
        OPEN_AKIYA_TEST_IMPORT_PROGRESS: '1',
        OPEN_AKIYA_TEST_DATA: directory,
        OPEN_AKIYA_LOCATION_SEARCH_URL: endpoint,
      },
    })
    await controlledTiles(application.context())
    const page = await application.firstWindow()
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true)
    return { application, page }
  }
  let session = await launch()
  try {
    await expect(
      session.page.getByRole('heading', { name: 'Open Akiya', exact: true }),
    ).toBeVisible()
    await expect(
      session.page.locator('.leaflet-tile-loaded').first(),
    ).toBeVisible()
    // Search is exercised over real sandbox IPC and worker HTTP, with a controlled
    // local provider. Leaflet circle geometry and narrow layout require a browser.
    await session.page.setViewportSize({ width: 390, height: 844 })
    await session.page.getByLabel('Radius (km)', { exact: true }).fill('7')
    await session.page.getByRole('button', { name: 'Apply area' }).click()
    const circle = session.page.locator('.leaflet-overlay-pane path').first()
    const before = await circle.getAttribute('d')
    await session.page.getByLabel('Japanese address or place').fill(' 京都 ')
    await session.page
      .getByRole('button', { name: 'Search places', exact: true })
      .click()
    const match = session.page.getByRole('button', {
      name: '京都市, 京都府, 日本',
      exact: true,
    })
    await expect(match).toBeVisible()
    expect(
      await session.page.getByLabel('Latitude', { exact: true }).inputValue(),
    ).toBe('35')
    await match.focus()
    await match.press('Enter')
    await expect(
      session.page.getByLabel('Latitude', { exact: true }),
    ).toHaveValue('36')
    await expect(
      session.page.getByLabel('Longitude', { exact: true }),
    ).toHaveValue('136')
    await expect(
      session.page.getByLabel('Radius (km)', { exact: true }),
    ).toHaveValue('7')
    await expect.poll(() => circle.getAttribute('d')).not.toBe(before)
    await expect
      .poll(async () => {
        const map = await session.page
          .getByRole('region', { name: 'Interactive synthetic map' })
          .boundingBox()
        const shape = await circle.boundingBox()
        return (
          Math.abs(shape!.x + shape!.width / 2 - map!.x - map!.width / 2) +
          Math.abs(shape!.y + shape!.height / 2 - map!.y - map!.height / 2)
        )
      })
      .toBeLessThan(5)
    expect(
      await session.page.evaluate(() =>
        window.openAkiya.listImports({ state: 'active' }),
      ),
    ).toEqual({ jobs: [] })
    expect(lookups).toHaveLength(1)
    expect(new URL(lookups[0]!, endpoint).searchParams.get('q')).toBe('京都')
    expect(
      await session.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await session.page.setViewportSize({ width: 1200, height: 850 })
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
    // Panning/zooming are exploration, never collection. Observe both active
    // execution and saved data so a fast completed import cannot escape detection.
    const map = session.page.getByRole('region', {
      name: 'Interactive synthetic map',
    })
    const bounds = await map.boundingBox()
    await session.page.mouse.move(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2,
    )
    await session.page.mouse.down()
    await session.page.mouse.move(
      bounds!.x + bounds!.width / 2 + 60,
      bounds!.y + bounds!.height / 2,
      { steps: 8 },
    )
    await session.page.mouse.up()
    await session.page
      .getByRole('button', { name: 'Zoom in', exact: true })
      .click()
    // Allow more than one detail delay and a renderer polling interval.
    await session.page.waitForTimeout(1000)
    expect(
      await session.page.evaluate(() =>
        window.openAkiya.listImports({ state: 'active' }),
      ),
    ).toEqual({ jobs: [] })
    expect(
      await session.page.evaluate(
        async () =>
          (
            await window.openAkiya.areaResults({
              area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
              showUnavailable: true,
            })
          ).listings,
      ),
    ).toEqual([])
    await session.page
      .getByRole('button', { name: 'Import sample listings' })
      .click()
    await expect(
      session.page.getByText(/Request accepted · created/),
    ).toBeVisible()
    const queue = session.page.getByRole('list', { name: 'Import queue' })
    await expect(queue).toContainText(/Stage: (discovering|fetching|saving)/)
    await expect(queue).toContainText('discovered')
    const accepted = await session.page.evaluate(
      async () =>
        (
          await window.openAkiya.inspectImportRequest(
            JSON.parse(localStorage.getItem('import-request-ids')!)[0],
          )
        ).jobIds[0],
    )
    await session.page.getByLabel('Radius (km)', { exact: true }).fill('4')
    await session.page.getByRole('button', { name: 'Apply area' }).click()
    await session.page.reload()
    await expect(
      session.page.getByLabel('Radius (km)', { exact: true }),
    ).toHaveValue('4')
    await expect(
      session.page.getByText(/Request accepted · created/),
    ).toBeVisible()
    expect(
      await session.page.evaluate(
        async (id) => (await window.openAkiya.inspectImport(id)).area.radiusKm,
        accepted,
      ),
    ).toBe(5)
    await expect(
      session.page.getByRole('list', { name: 'Import queue' }),
    ).toContainText('Job area: 35, 135')
    // Interrupt the real runtime after reconnect; the same durable request must
    // remain inspectable and discover its committed results on launcher restart.
    await session.application.close()
    session = await launch()
    await expect(
      session.page.getByText(/Request accepted · created/),
    ).toBeVisible()
    await expect(
      session.page.getByLabel('Radius (km)', { exact: true }),
    ).toHaveValue('4')
    const listing = session.page.getByRole('button', {
      name: 'Sample sale listing',
      exact: true,
    })
    await expect(listing).toBeVisible()
    await expect(
      session.page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      session.page.getByRole('list', { name: 'Import queue' }),
    ).toContainText('Search finished')
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
    await expect(
      session.page.getByLabel('Radius (km)', { exact: true }),
    ).toHaveValue('4')
    await expect(
      session.page.getByText(/Request accepted · created/),
    ).toBeVisible()
    await expect(
      session.page.getByRole('list', { name: 'Import queue' }),
    ).toContainText('Search finished')
    const boundary = await session.page.evaluate(() => ({
      methods: Object.keys(window.openAkiya).sort(),
      nodeVisible: 'require' in window || 'process' in window,
    }))
    expect(boundary.nodeVisible).toBe(false)
    expect(
      await session.application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true)
    expect(boundary.methods).toEqual([
      'areaResults',
      'cancelImport',
      'cancelImportRequest',
      'createImportRequest',
      'inspectImport',
      'inspectImportRequest',
      'listImports',
      'searchLocations',
    ])
  } finally {
    await session.application.close()
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    )
    rmSync(directory, { recursive: true, force: true })
  }
})
