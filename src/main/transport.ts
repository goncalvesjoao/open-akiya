import { LocalApiError } from './errors'
import type { AdapterContext } from './adapter'

export type TransportResponse = {
  status: number
  headers?: Record<string, string>
  body?: unknown
}
export type WorkerTransport = (
  url: string,
  options: RequestInit,
) => Promise<TransportResponse>
export type TransportOptions = {
  transport?: WorkerTransport
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  requestTimeoutMs?: number
  minimumIntervalMs?: number
}
export function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}
const failure = (code: string, message: string, retryable = false) =>
  new LocalApiError(409, code, message, retryable)

// Adapters receive this capability instead of a network implementation. Every
// physical attempt (including redirect hops) passes accounting and host pacing.
export function workerRequest(input: {
  hosts: string[]
  signal: AbortSignal
  now(): number
  ensure(): void
  account(kind: 'discovery' | 'detail'): void
  next(host: string): number
  saveNext(host: string, time: number): void
  retry(time: number | null): void
  options: TransportOptions
  queue: { tail: Promise<void> }
}): AdapterContext['request'] {
  const sleep = input.options.wait ?? wait
  const transport = input.options.transport ?? (async () => ({ status: 200 }))
  const interval = Math.max(2000, input.options.minimumIntervalMs ?? 2000)
  return (kind, initialUrl, options = {}) => {
    const run = async () => {
      let url = initialUrl
      let retries = 0
      let redirects = 0
      while (true) {
        input.ensure()
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw failure('INVALID_SOURCE_URL', 'Source URL rejected')
        }
        if (
          parsed.protocol !== 'https:' ||
          parsed.username ||
          parsed.password ||
          !input.hosts.includes(parsed.hostname)
        )
          throw failure('INVALID_SOURCE_URL', 'Source URL rejected')
        const pause = input.next(parsed.hostname) - input.now()
        if (pause > 0) await sleep(pause, input.signal)
        input.ensure()
        input.account(kind)
        input.saveNext(parsed.hostname, input.now() + interval)
        const controller = new AbortController()
        const abort = () => controller.abort(input.signal.reason)
        input.signal.addEventListener('abort', abort, { once: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        let response: TransportResponse
        try {
          const interrupted = new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () =>
                reject(
                  input.signal.aborted
                    ? input.signal.reason
                    : failure('TIMEOUT', 'Source request timed out', true),
                ),
              { once: true },
            )
          })
          timer = setTimeout(
            () => controller.abort(),
            input.options.requestTimeoutMs ?? 30000,
          )
          response = await Promise.race([
            transport(url, {
              ...options,
              redirect: 'manual',
              signal: controller.signal,
            }),
            interrupted,
          ])
        } catch (error) {
          if (input.signal.aborted) throw error
          const classified =
            error instanceof LocalApiError
              ? error
              : failure('TRANSPORT_ERROR', 'Source request failed', true)
          if (classified.retryable && retries++ < 2) {
            const next = input.now() + 1000 * 2 ** (retries - 1)
            input.retry(next)
            await sleep(next - input.now(), input.signal)
            input.retry(null)
            continue
          }
          throw classified
        } finally {
          clearTimeout(timer)
          input.signal.removeEventListener('abort', abort)
        }
        input.ensure()
        const headers = Object.fromEntries(
          Object.entries(response.headers ?? {}).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        )
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (++redirects > 5 || !headers.location)
            throw failure(
              'CONFIGURATION_ERROR',
              'Source redirect limit or destination invalid',
            )
          url = new URL(headers.location, url).href
          continue
        }
        if (response.status === 429 || response.status >= 500) {
          const error =
            response.status === 429
              ? failure('RATE_LIMITED', 'Source rate limited requests', true)
              : failure(
                  'TRANSPORT_ERROR',
                  'Source temporarily unavailable',
                  true,
                )
          if (retries++ >= 2) throw error
          const value = headers['retry-after']
          const seconds =
            value && /^\d+$/.test(value)
              ? Number(value) * 1000
              : Date.parse(value ?? '') - input.now()
          const delay = Math.max(
            1000 * 2 ** (retries - 1),
            Number.isFinite(seconds) ? seconds : 0,
          )
          // Do not retry early when a source asks for an impractically long wait.
          if (delay > 60000) throw error
          input.retry(input.now() + delay)
          await sleep(delay, input.signal)
          input.retry(null)
          continue
        }
        if ([401, 403].includes(response.status))
          throw failure('SOURCE_BLOCKED', 'Source access is blocked')
        if (response.status < 200 || response.status >= 300)
          throw failure('CONFIGURATION_ERROR', 'Source response is unsupported')
        return response.body ?? null
      }
    }
    const result = input.queue.tail.then(run)
    input.queue.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
