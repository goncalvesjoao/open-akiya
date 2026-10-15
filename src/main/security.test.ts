import { expect, it, vi } from 'vitest'
import { registerDomainHandlers } from './security'

it('registered handlers reject foreign contents, child frames and changed application URLs', async () => {
  const handlers = new Map<
    string,
    (
      event: { sender: unknown; senderFrame: { url: string } | null },
      input: unknown,
    ) => Promise<unknown>
  >()
  const frame = { url: 'file:///app/index.html' }
  const contents = { mainFrame: frame }
  const call = vi.fn().mockResolvedValue({ id: 'request-1' })
  registerDomainHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => contents,
    frame.url,
    call,
  )
  const handler = handlers.get('akiya:createImportRequest')!
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { url: frame.url } },
    { sender: contents, senderFrame: null },
  ])
    await expect(handler(event, {})).resolves.toMatchObject({
      error: { code: 'UNTRUSTED_SENDER' },
    })
  frame.url = 'file:///app/index.html?foreign=1'
  await expect(
    handler({ sender: contents, senderFrame: frame }, {}),
  ).resolves.toMatchObject({ error: { code: 'UNTRUSTED_SENDER' } })
  expect(call).not.toHaveBeenCalled()
  frame.url = 'file:///app/index.html'
  await expect(
    handler({ sender: contents, senderFrame: frame }, { intent: 'import' }),
  ).resolves.toEqual({ result: { id: 'request-1' } })
  expect(call).toHaveBeenCalledExactlyOnceWith('createImportRequest', {
    intent: 'import',
  })
  expect([...handlers.keys()].sort()).toEqual([
    'akiya:areaResults',
    'akiya:cancelImport',
    'akiya:createImportRequest',
    'akiya:inspectImport',
    'akiya:inspectImportRequest',
    'akiya:listImports',
  ])
})
it('returns safe structured errors without exposing private worker failures', async () => {
  const handlers = new Map<
    string,
    (
      event: { sender: unknown; senderFrame: { url: string } | null },
      input: unknown,
    ) => Promise<unknown>
  >()
  const frame = { url: 'file:///app/index.html' }
  const contents = { mainFrame: frame }
  registerDomainHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => contents,
    frame.url,
    async () => {
      throw new Error('secret sqlite raw evidence')
    },
  )
  expect(
    await handlers.get('akiya:inspectImport')!(
      { sender: contents, senderFrame: frame },
      'id',
    ),
  ).toEqual({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Local worker operation failed. Saved data is retained.',
      retryable: false,
    },
  })
})
