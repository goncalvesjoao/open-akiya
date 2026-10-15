import { expect, test } from '@playwright/test'

test('visitors can learn about the project from the landing page', async ({
  page,
}) => {
  await page.goto('/')

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'An empty house. A new beginning. An open map.',
    }),
  ).toBeVisible()

  await page.getByRole('link', { name: 'Meet the project' }).click()

  await expect(page).toHaveURL(/\/#about$/)
  await expect(
    page.getByRole('heading', {
      name: 'A clearer way to find a place in Japan.',
    }),
  ).toBeInViewport()
})
