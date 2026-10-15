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
