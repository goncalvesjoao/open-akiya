import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real Electron covers preload/worker scheduling and the map's saved results;
// state/error permutations remain in simulated-DOM and worker API tests.
test('refresh attaches to ordinary work and follows queued rechecks to final request success', async () => {
  test.setTimeout(60000)
  const directory = mkdtempSync(join(tmpdir(), 'akiya-refresh-'))
  const application = await electron.launch({
    args: [
      '--host-resolver-rules=MAP *.tile.openstreetmap.org 127.0.0.1',
      'out/main/index.cjs',
    ],
    env: {
      ...process.env,
      OPEN_AKIYA_TEST_HIDDEN: '1',
      OPEN_AKIYA_TEST_DATA: directory,
      OPEN_AKIYA_TEST_IMPORT_PROGRESS: '1',
      OPEN_AKIYA_TEST_MANUAL_REFRESH: '1',
    },
  })
  try {
    await application.context().route('https://**/*', (route) => route.abort())
    const page = await application.firstWindow()
    await page.setViewportSize({ width: 1200, height: 1800 })
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    await expect(
      page.getByRole('button', { name: 'Sample sale listing', exact: true }),
    ).toBeVisible({ timeout: 15000 })
    await expect
      .poll(() =>
        page.evaluate(() => window.openAkiya.listImports({ state: 'active' })),
      )
      .toEqual({ jobs: [] })
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    await page.getByRole('button', { name: 'Refresh anyway' }).click()
    await expect(page.getByText(/Request accepted · attached/)).toBeVisible()
    const refresh = await page.evaluate(async () => {
      const id = JSON.parse(localStorage.getItem('import-last-request-id')!)
      const request = await window.openAkiya.inspectImportRequest(id)
      await window.openAkiya.createImportRequest({
        area: { ...request.area, center: { latitude: 36, longitude: 136 } },
        intent: 'import',
        idempotencyKey: 'queue-before-followup',
      })
      return request
    })
    expect(refresh.pendingFollowUp).toBe(true)
    await page.getByRole('button', { name: 'Refresh anyway' }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem('import-last-request-id')!),
        ),
      )
      .toBe(refresh.id)
    await expect(
      page.getByRole('list', { name: 'Your import requests' }),
    ).toContainText('Refresh pending')
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => window.openAkiya.inspectImportRequest(id),
              refresh.id,
            )
          ).jobIds.length,
      )
      .toBe(2)
    const pending = await page.evaluate(
      (id) => window.openAkiya.inspectImportRequest(id),
      refresh.id,
    )
    await expect(
      page.getByRole('listitem', { name: `Import job ${pending.jobIds[1]}` }),
    ).toContainText('queued')
    await expect(page.getByText('Refresh succeeded')).toHaveCount(0)
    await expect(page.getByText('Refresh succeeded')).toBeVisible()
    const completed = await page.evaluate(
      (id) => window.openAkiya.inspectImportRequest(id),
      refresh.id,
    )
    expect(completed).toMatchObject({
      state: 'succeeded',
      pendingFollowUp: false,
    })
    expect(completed.jobIds).toHaveLength(2)
    await expect(
      page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
