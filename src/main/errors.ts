import type { ApiError } from '../shared/desktop'
export class LocalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export function safeError(error: unknown): ApiError {
  return error instanceof LocalApiError
    ? { code: error.code, message: error.message, retryable: false }
    : {
        code: 'INTERNAL_ERROR',
        message: 'Local worker operation failed. Saved data is retained.',
        retryable: false,
      }
}
export function invalid(message = 'Invalid request'): never {
  throw new LocalApiError(400, 'INVALID_REQUEST', message)
}
