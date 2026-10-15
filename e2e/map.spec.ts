import { expect, test } from '@playwright/test'

test('explores synthetic listings through keyboard selection, map pins and shared details without collection', async ({
  page,
}) => {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  )
  const collection: string[] = []
  page.on('request', (request) => {
    if (/api\/|supabase|example.invalid/.test(request.url()))
      collection.push(request.url())
  })
  await page.goto('/')
  await page.getByRole('link', { name: 'Synthetic map', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Synthetic map', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Pin: Sample rental listing', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Listing details' }),
  ).toContainText('¥35,000 / month')
  await page
    .getByRole('button', { name: 'Sample sale listing', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Listing details' }),
  ).toContainText('Sale: Free (¥0)')
  await expect(
    page.getByRole('button', { name: 'Sample sale listing', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByLabel('Show unavailable').check()
  await expect(
    page.getByRole('button', {
      name: 'Unavailable sample listing',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Pin: Unavailable sample listing',
      exact: true,
    }),
  ).toBeVisible()
  await page.getByLabel('Radius (km)').fill('11')
  await page.getByRole('button', { name: 'Apply area' }).click()
  await expect(page.getByRole('alert')).toContainText('at most 10')
  await expect(page.getByText('Selected: 35, 135 · 5 km')).toBeVisible()
  await page.getByLabel('Radius (km)').fill('0.05')
  await page.getByRole('button', { name: 'Apply area' }).click()
  await expect(
    page.getByRole('button', {
      name: 'Sample listing with unknown price',
      exact: true,
    }),
  ).toHaveCount(0)
  await page.getByLabel('Latitude').fill('0')
  await page.getByLabel('Longitude').fill('0')
  await page.getByRole('button', { name: 'Apply area' }).click()
  await expect(
    page.getByRole('button', { name: 'Boundary sample listing', exact: true }),
  ).toBeVisible()
  expect(collection).toEqual([])
})

// Pointer conversion, SVG circle rendering, drag and zoom require real layout.
test('supports pointer area selection, pan and zoom, mobile results and controlled source navigation when tiles fail', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.abort(),
  )
  await context.route('https://example.invalid/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Controlled synthetic source</h1>',
    }),
  )
  await page.goto('/#map')
  const map = page.getByRole('region', { name: 'Interactive synthetic map' })
  await expect(
    page.getByText('Map tiles unavailable.', { exact: false }),
  ).toBeVisible()
  await map.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await map.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await map.scrollIntoViewIfNeeded()
  const box = await map.boundingBox()
  if (!box) throw new Error('Map has no layout')
  await page.mouse.move(box.x + 90, box.y + 180)
  await page.mouse.down()
  await page.mouse.move(box.x + 130, box.y + 200, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByText('Selected: 35, 135 · 5 km')).toBeVisible()
  await map.click({ position: { x: 75, y: 260 } })
  await expect(page.getByLabel('Latitude', { exact: true })).not.toHaveValue(
    '35',
  )
  await page.getByLabel('Latitude', { exact: true }).fill('35')
  await page.getByLabel('Longitude', { exact: true }).fill('135')
  await page.getByRole('button', { name: 'Apply area' }).click()
  await page
    .getByRole('button', { name: 'Sample sale listing', exact: true })
    .click()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Original source' }).click()
  const popup = await popupPromise
  await expect(popup).toHaveURL('https://example.invalid/offers/sale-1')
  await expect(popup.getByRole('heading')).toHaveText(
    'Controlled synthetic source',
  )
  await page.getByLabel('Latitude', { exact: true }).fill('50')
  await page.getByRole('button', { name: 'Apply area' }).click()
  await expect(
    page.getByText('No listings in this selected area.', { exact: false }),
  ).toBeVisible()
})

// Leaflet viewport placement after a pointer drag requires real browser layout.
test('keeps the manually panned viewport when selecting listings and toggling unavailable offers', async ({
  page,
}) => {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.abort(),
  )
  await page.goto('/#map')
  const map = page.getByRole('region', { name: 'Interactive synthetic map' })
  const marker = map.getByRole('button', {
    name: 'Pin: Sample listing with unknown price',
    exact: true,
  })
  await expect(marker).toBeVisible()
  await map.scrollIntoViewIfNeeded()
  const before = await marker.boundingBox()
  const box = await map.boundingBox()
  if (!before || !box) throw new Error('Map or marker has no layout')
  await page.mouse.move(box.x + 80, box.y + 120)
  await page.mouse.down()
  await page.mouse.move(box.x + 160, box.y + 160, { steps: 8 })
  await page.mouse.up()
  await expect
    .poll(async () => (await marker.boundingBox())?.x)
    .toBeCloseTo(before.x + 80, 0)
  const panned = await marker.boundingBox()
  if (!panned) throw new Error('Panned marker has no layout')
  async function expectPanPreserved() {
    await expect
      .poll(async () => (await marker.boundingBox())?.x)
      .toBeCloseTo(panned!.x, 0)
    await expect
      .poll(async () => (await marker.boundingBox())?.y)
      .toBeCloseTo(panned!.y, 0)
  }
  await page
    .getByRole('button', { name: 'Sample sale listing', exact: true })
    .click()
  await expectPanPreserved()
  await map
    .getByRole('button', { name: 'Pin: Sample rental listing', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Listing details' }),
  ).toContainText('Sample rental listing')
  await expectPanPreserved()
  await page.getByLabel('Show unavailable').check()
  await expect(
    map.getByRole('button', {
      name: 'Pin: Unavailable sample listing',
      exact: true,
    }),
  ).toBeVisible()
  await expectPanPreserved()
  await expect(page.getByText('Selected: 35, 135 · 5 km')).toBeVisible()
})
