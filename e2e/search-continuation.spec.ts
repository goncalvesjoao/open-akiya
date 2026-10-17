import { controlledTiles } from './controlled-tiles'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Browser coverage exercises real preload/worker continuation and saved map pins.
// Control/error permutations stay at the simulated-DOM seam.
test('continues bounded saved discovery without losing map or list results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'akiya-continuation-'))
  const app = await electron.launch({
    args: [
      '--host-resolver-rules=MAP tile.openstreetmap.org 127.0.0.1, MAP *.tile.openstreetmap.org 127.0.0.1',
      'out/main/index.cjs',
    ],
    env: {
      ...process.env,
      OPEN_AKIYA_TEST_HIDDEN: '1',
      OPEN_AKIYA_TEST_DATA: directory,
      OPEN_AKIYA_TEST_CONTINUATION: '1',
    },
  })
  try {
    await controlledTiles(app.context())
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1200, height: 1800 })
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    await expect(
      page.getByText('Partial results—continue search'),
    ).toBeVisible()
    const saved = page.getByRole('button', {
      name: 'Sample sale listing',
      exact: true,
    })
    await expect(saved).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: 'Continue search', exact: true })
      .first()
      .click()
    await expect(saved).toBeVisible()
    await expect(page.getByText(/Request accepted · continued/)).toBeVisible()
    const request = await page.evaluate(async () => {
      const id = JSON.parse(localStorage.getItem('import-last-request-id')!)
      return window.openAkiya.inspectImportRequest(id)
    })
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => window.openAkiya.inspectImport(id),
              request.jobIds[0],
            )
          ).state,
      )
      .toBe('partial')
    await expect(
      page.getByRole('listitem', { name: `Import job ${request.jobIds[0]}` }),
    ).toContainText('Partial results—continue search')
    await expect(saved).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Unverified sample listing',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Pin: Unverified sample listing · Location unverified',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
