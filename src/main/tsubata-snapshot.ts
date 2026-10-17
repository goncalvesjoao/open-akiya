import { createHash } from 'node:crypto'
import type { AdapterContext } from './adapter'
import { LocalApiError } from './errors'
export const tsubataExportUrl =
  'https://www.town.tsubata.lg.jp/division/file/opendata/173614_empty_bank.csv'
export type ExportSnapshot<T> = {
  fingerprint: string
  fetchedAt: string
  rows: T[]
}

// Worker-private acquisition: the parser must finish successfully before bytes
// become a reusable immutable snapshot. Last-Modified is deliberately unused.
export function acquireTsubataSnapshot<T>(
  context: AdapterContext,
  parserVersion: string,
  parse: (body: string) => T[],
): Promise<ExportSnapshot<T>> {
  return context.snapshot(
    `tsubata:${parserVersion}`,
    async () => {
      const response = (await context.request('discovery', tsubataExportUrl, {
        responseMetadata: true,
        maximumBytes: 262144,
      })) as { body: string; headers: Record<string, string> }
      const body = response.body
      if (
        /text\/html/i.test(response.headers['content-type'] ?? '') ||
        /^\s*(?:<!doctype\s+html|<html|<script)/i.test(body) ||
        /(?:captcha|verify you are human|access denied)/i.test(
          body.slice(0, 2048),
        )
      )
        throw new LocalApiError(
          409,
          'SOURCE_BLOCKED',
          'Source returned an access challenge or block',
        )
      return {
        fingerprint: createHash('sha256').update(body).digest('hex'),
        fetchedAt: context.now(),
        rows: parse(body),
      }
    },
    86400000,
  )
}
