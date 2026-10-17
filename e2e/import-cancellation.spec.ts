import { controlledTiles } from './controlled-tiles'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real Electron verifies the queue controls cross sandboxed preload IPC into
// the durable worker, and that settled committed results reach Leaflet pins.
test('cancels shared intent, queued and running work without losing committed map results or resuming on relaunch', async () => {
  test.setTimeout(60000)
  const directory = mkdtempSync(join(tmpdir(), 'akiya-cancellation-'))
  async function launch() {
    const application = await electron.launch({
      args: [
        '--host-resolver-rules=MAP tile.openstreetmap.org 127.0.0.1, MAP *.tile.openstreetmap.org 127.0.0.1',
        'out/main/index.cjs',
      ],
      env: {
        ...process.env,
        OPEN_AKIYA_TEST_HIDDEN: '1',
        OPEN_AKIYA_TEST_DATA: directory,
        OPEN_AKIYA_TEST_IMPORT_QUEUE: '1',
      },
    })
    await controlledTiles(application.context())
    return { application, page: await application.firstWindow() }
  }
  let session = await launch()
  try {
    const page = session.page
    await page.setViewportSize({ width: 1200, height: 1800 })
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    const first = await page.evaluate(async () => {
      const { jobs } = await window.openAkiya.listImports({ state: 'active' })
      return jobs[0]!
    })
    await expect
      .poll(async () =>
        page.evaluate((id) => window.openAkiya.inspectImport(id), first.id),
      )
      .toMatchObject({ state: 'running' })
    const shared = await page.evaluate(
      (area) =>
        window.openAkiya.createImportRequest({
          area,
          intent: 'import',
          idempotencyKey: 'shared-electron-request',
        }),
      first.area,
    )
    expect(shared.disposition).toBe('attached')
    await page.reload()
    // Reload recovers jobs, while a fresh UI submission records this window's
    // request intent without deciding ownership locally.
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    await page
      .getByRole('list', { name: 'Your import requests' })
      .getByRole('listitem')
      .filter({ hasText: 'attached' })
      .getByRole('button', { name: 'Cancel request intent' })
      .click()
    expect(
      await page.evaluate((id) => window.openAkiya.inspectImport(id), first.id),
    ).toMatchObject({ state: 'running', cancelRequestedAt: null })
    expect(
      await page.evaluate(
        (id) => window.openAkiya.inspectImportRequest(id),
        shared.id,
      ),
    ).toMatchObject({ state: 'running' })

    await page.getByLabel('Latitude', { exact: true }).fill('36')
    await page.getByRole('button', { name: 'Apply area' }).click()
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    await page.getByLabel('Latitude', { exact: true }).fill('35.01')
    await page.getByRole('button', { name: 'Apply area' }).click()
    await page.getByRole('button', { name: 'Import sample listings' }).click()
    const jobs = await page.evaluate(() =>
      window.openAkiya.listImports({ state: 'active' }),
    )
    expect(jobs.jobs.map((job) => job.area.center.latitude)).toEqual([
      35, 36, 35.01,
    ])
    const queue = page.getByRole('list', { name: 'Import queue' })
    await expect
      .poll(() =>
        queue
          .getByRole('listitem')
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute('aria-label')),
          ),
      )
      .toEqual(jobs.jobs.map((job) => `Import job ${job.id}`))
    await expect(queue.getByRole('listitem').first()).toContainText(
      'Job area: 35, 135',
    )
    await page
      .getByRole('listitem', {
        name: `Import job ${jobs.jobs[1]!.id}`,
        exact: true,
      })
      .getByRole('button', { name: 'Cancel queued job' })
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.openAkiya.inspectImport(id),
          jobs.jobs[1]!.id,
        ),
      )
      .toMatchObject({ state: 'cancelled' })

    await page.getByLabel('Latitude', { exact: true }).fill('35')
    await page.getByRole('button', { name: 'Apply area' }).click()
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const job = await window.openAkiya.inspectImport(id)
          return job.state === 'running' && job.counts.added > 0
        }, first.id),
      )
      .toBe(true)
    const committed = await page.evaluate(
      (id) => window.openAkiya.inspectImport(id),
      first.id,
    )
    await page
      .getByRole('listitem', { name: `Import job ${first.id}`, exact: true })
      .getByRole('button', { name: 'Cancel running job' })
      .click()
    await expect
      .poll(() =>
        page.evaluate((id) => window.openAkiya.inspectImport(id), first.id),
      )
      .toMatchObject({ state: 'cancelled' })
    const cancelled = await page.evaluate(
      (id) => window.openAkiya.inspectImport(id),
      first.id,
    )
    expect(cancelled.counts.added).toBeGreaterThanOrEqual(
      committed.counts.added,
    )
    expect(cancelled.counts.added).toBeLessThan(cancelled.counts.discovered)
    await expect(
      page.getByRole('button', { name: 'Sample sale listing', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    // The remaining accepted overlapping job advances despite the cancelled
    // queue entry; cancel it explicitly before checking restart recovery.
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.openAkiya.inspectImport(id),
          jobs.jobs[2]!.id,
        ),
      )
      .toMatchObject({ state: 'running' })
    await page
      .getByRole('listitem', {
        name: `Import job ${jobs.jobs[2]!.id}`,
        exact: true,
      })
      .getByRole('button', { name: 'Cancel running job' })
      .click()
    await expect
      .poll(() =>
        page.evaluate(() => window.openAkiya.listImports({ state: 'active' })),
      )
      .toEqual({ jobs: [] })
    const settled = await page.evaluate(
      (id) => window.openAkiya.inspectImport(id),
      first.id,
    )
    await session.application.close()
    session = await launch()
    await expect(
      session.page.getByRole('button', {
        name: 'Pin: Sample sale listing',
        exact: true,
      }),
    ).toBeVisible()
    expect(
      await session.page.evaluate(() =>
        window.openAkiya.listImports({ state: 'active' }),
      ),
    ).toEqual({ jobs: [] })
    expect(
      await session.page.evaluate(
        (id) => window.openAkiya.inspectImport(id),
        first.id,
      ),
    ).toEqual(settled)
  } finally {
    await session.application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
