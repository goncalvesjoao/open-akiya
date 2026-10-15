import type { DesktopAPI } from '../shared/desktop'
import { safeError } from './errors'

type Frame = { url: string }
type Contents = { mainFrame: Frame }
type SenderEvent = { sender: unknown; senderFrame: Frame | null }
type Handler = (event: SenderEvent, input: unknown) => Promise<unknown>
const operations: (keyof DesktopAPI)[] = [
  'createImportRequest',
  'inspectImportRequest',
  'inspectImport',
  'cancelImport',
  'listImports',
  'areaResults',
]

export function registerDomainHandlers(
  ipc: { handle(channel: string, handler: Handler): void },
  owningContents: () => Contents | null,
  applicationURL: string,
  call: (operation: keyof DesktopAPI, input: unknown) => Promise<unknown>,
) {
  for (const operation of operations) {
    ipc.handle(`akiya:${operation}`, async (event, input) => {
      const contents = owningContents()
      if (
        !contents ||
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        event.senderFrame.url !== applicationURL
      ) {
        return {
          error: {
            code: 'UNTRUSTED_SENDER',
            message: 'Untrusted sender',
            retryable: false,
          },
        }
      }
      try {
        return { result: await call(operation, input) }
      } catch (error) {
        return { error: safeError(error) }
      }
    })
  }
}
