import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtures } from '../src/main/fixtures'

// Browser coverage is necessary for failed Leaflet tile loads, mobile layout and
// real keyboard focus across loading/recovery. IPC is the controlled query seam.
test('recovers by keyboard on mobile while map tiles fail', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-recovery-'))
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
  await application.context().route('https://**/*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'image/png',
      body: 'failed tile',
    }),
  )
  const page = await application.firstWindow()
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await application.evaluate(({ ipcMain, session }, listing) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['https://tile.openstreetmap.org/*'] },
        (_details, callback) => callback({ cancel: true }),
      )
      ipcMain.removeHandler('akiya:areaResults')
      let rejected = false
      ipcMain.handle('akiya:areaResults', async (_event, query) => {
        if (query.area.center.latitude === 34) {
          await new Promise<void>((resolve) =>
            ipcMain.once('test:release-query', () => resolve()),
          )
          if (!rejected) {
            rejected = true
            return {
              error: {
                code: 'TIMEOUT',
                message: 'Controlled rejection',
                retryable: true,
              },
            }
          }
        }
        return {
          result: {
            ...query,
            mode: 'synthetic',
            listings: query.area.center.latitude !== 35 ? [] : [listing],
            municipalityGroups: [],
            coverage: {
              status: 'partial',
              lastSuccessfulCheckAt: '2026-10-14T00:00:00Z',
              freshUntil: null,
              scopeKey: null,
              caveats: ['Synthetic coverage; location accuracy varies'],
            },
            generatedAt: '2026-10-15T00:00:00Z',
          },
        }
      })
    }, fixtures[0])
    await page.reload()
    await page
      .getByRole('region', { name: 'Interactive synthetic map' })
      .scrollIntoViewIfNeeded()
    await expect(page.getByText(/Map tiles unavailable/)).toBeVisible()
    const results = page.getByRole('list', { name: 'Listing results' })
    await results.getByRole('button').click()
    await expect(
      page.getByRole('region', { name: 'Listing details' }),
    ).toContainText('Last successful check:')
    const latitude = page.getByLabel('Latitude', { exact: true })
    await latitude.fill('34')
    await page.getByRole('button', { name: 'Apply area' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Loading listings…')).toBeVisible()
    await expect(results.getByRole('button')).toHaveCount(0)
    await application.evaluate(({ ipcMain }) => {
      ipcMain.emit('test:release-query')
    })
    await expect(page.getByText(/Listing query failed/)).toBeVisible()
    await expect(page.getByText('Selected: 34, 135 · 5 km')).toBeVisible()
    const retry = page.getByRole('button', { name: 'Retry listing query' })
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Loading listings…')).toBeFocused()
    await application.evaluate(({ ipcMain }) => {
      ipcMain.emit('test:release-query')
    })
    await expect(page.getByText(/0 synthetic listings/)).toBeFocused()
    await latitude.fill('33')
    await page.getByRole('button', { name: 'Apply area' }).focus()
    await page.keyboard.press('Enter')
    await expect(
      page.getByText(/No listings in this selected area/),
    ).toBeVisible()
    await latitude.fill('35')
    await page.getByRole('button', { name: 'Apply area' }).focus()
    await page.keyboard.press('Enter')
    const row = results.getByRole('button')
    await row.focus()
    await page.keyboard.press('Enter')
    const details = page.getByRole('region', { name: 'Listing details' })
    await expect(details).toContainText('Last successful check:')
    await expect(page.getByText(/Coverage partial/)).toContainText(
      '2026-10-14T00:00:00Z',
    )
    await expect(page.getByText(/Sample data only/)).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await expect(
      details.getByRole('link', { name: 'Original source ↗' }),
    ).toBeVisible()
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
