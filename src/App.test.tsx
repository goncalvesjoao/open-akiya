import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import App from './App'

test('invites visitors to contribute through the project repository', () => {
  render(<App />)

  expect(screen.getByRole('link', { name: 'Build with us' })).toHaveAttribute(
    'href',
    'https://github.com/goncalvesjoao/open-akiya',
  )
})

test('retains the selected area when empty or invalid coordinate drafts are submitted and displays unknown money', async () => {
  const { fireEvent } = await import('@testing-library/react')
  render(<App />)
  fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply area' }))
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Last valid selection retained',
  )
  expect(screen.getByText('Selected: 35, 135 · 5 km')).toBeVisible()
  fireEvent.click(
    await screen.findByRole('button', {
      name: '価格未定のサンプル',
    }),
  )
  expect(
    screen.getByRole('region', { name: 'Listing details' }),
  ).toHaveTextContent('Sale: Unknown')
})
