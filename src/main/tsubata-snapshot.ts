import { createHash } from 'node:crypto'
import type { AdapterContext, Candidate, DetailEvidence, NormalizationResult, SourceAdapter } from './adapter'
import { LocalApiError } from './errors'

export const tsubataExportUrl = 'https://www.town.tsubata.lg.jp/division/file/opendata/173614_empty_bank.csv'
type Row = Record<string, string>
type Snapshot = { fingerprint: string; fetchedAt: string; rows: {values: Row; invalid: boolean}[] }
const failure = (code: string, message: string): never => { throw new LocalApiError(409, code, message) }

// Snapshot acquisition/processing only. #33 owns geographic eligibility and #34
// owns factual normalization. Neither callback may fetch linked assets.
export function tsubataSnapshotAdapter(input: {
  parserVersion: string
  candidate(row: Row): Candidate
  normalize(evidence: DetailEvidence): NormalizationResult
}): SourceAdapter {
  const snapshot = (context: AdapterContext) => context.snapshot<Snapshot>(`tsubata:${input.parserVersion}`, async () => {
    const response = await context.request('discovery', tsubataExportUrl, {responseMetadata: true}) as {body: string; headers: Record<string, string>}
    const body = response.body
    if (/text\/html/i.test(response.headers['content-type'] ?? '') || /^\s*(?:<!doctype\s+html|<html|<script)/i.test(body) || /(?:captcha|verify you are human|access denied)/i.test(body.slice(0, 2048))) failure('SOURCE_BLOCKED', 'Source returned an access challenge or block')
    if (typeof body !== 'string') failure('PARSE_ERROR', 'Expected a complete UTF-8 CSV export')
    const text = body as string
    const rows = parseCsv(text)
    const headers = rows.shift()!
    const required = ['全国地方公共団体コード', 'ID', '契約形態', '金額', '受付状況']
    if (required.some(field => !headers.includes(field)) || new Set(headers).size !== headers.length)
      failure('PARSE_ERROR', 'CSV export headers are incompatible')
    const identities = rows.map(row => JSON.stringify([row[headers.indexOf('全国地方公共団体コード')], row[headers.indexOf('ID')], row[headers.indexOf('契約形態')]]))
    return { fingerprint: createHash('sha256').update(text).digest('hex'), fetchedAt: context.now(), rows: rows.map((row, index) => ({values: Object.fromEntries(headers.map((header, offset) => [header, row[offset] ?? ''])), invalid: row.length !== headers.length || !row[headers.indexOf('ID')]?.trim() || identities.indexOf(identities[index]) !== identities.lastIndexOf(identities[index])})) }
  }, 86400000)
  const candidateAt = (data: Snapshot, index: number): Candidate => {
    const row = data.rows[index]
    return row.invalid ? {snapshotFingerprint: data.fingerprint, externalId: `rejected-row:${data.fingerprint}:${index}`, transactionType: 'unknown', url: tsubataExportUrl, location: {kind: 'unknown'}, municipalityId: null, publishedAt: null, modifiedAt: null, relevance: 'plausible'} : {...input.candidate(row.values), snapshotFingerprint: data.fingerprint}
  }
  return {
    capabilities: { sourceId: 'tsubata-open-data', adapterVersion: `tsubata-snapshot-v1:${input.parserVersion}`, queryVersion: 'municipal-csv-v1', geography: 'municipality', dateOrdering: null, cursorVersion: 'snapshot-v1', allowedHosts: ['www.town.tsubata.lg.jp'], allowedUrls: [tsubataExportUrl], minimumIntervalMs: 10000 },
    async discover(_request, context) {
      const data = await snapshot(context)
      return { candidates: data.rows.map((_, index) => candidateAt(data, index)), nextCursor: null, exhausted: true, limitation: null }
    },
    async fetchDetail(candidate, context) {
      const data = await snapshot(context)
      if (candidate.snapshotFingerprint && candidate.snapshotFingerprint !== data.fingerprint) failure('SNAPSHOT_INVALID', 'Saved processing snapshot is no longer compatible')
      context.consumeRow()
      const row = data.rows.find((_, index) => candidateAt(data, index).externalId === candidate.externalId && candidateAt(data, index).transactionType === candidate.transactionType)
      if (!row) failure('OFFER_NOT_CHECKED', 'Offer absent from acquired export; availability is unchanged')
      return { identity: {sourceId: 'tsubata-open-data', externalId: candidate.externalId}, url: candidate.url, fetchedAt: data.fetchedAt, payload: row!.values, provenance: { snapshot: data.fingerprint, ...(row!.invalid ? {rejected: 'Invalid or ambiguous CSV row'} : {}), source: tsubataExportUrl } }
    },
    normalize: evidence => evidence.provenance.rejected ? {kind: 'rejected', error: {code: 'PARSE_ERROR', message: 'Invalid or ambiguous CSV row', retryable: false}} : input.normalize(evidence),
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, closed = false
  text = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++ }
        else { quoted = false; closed = true }
      } else cell += character
    } else if (character === '"' && !cell && !closed) quoted = true
    else if (character === ',' || character === '\n') {
      row.push(cell); cell = ''; closed = false
      if (character === '\n') { rows.push(row); row = [] }
    } else if (character === '\r' && text[index + 1] === '\n') continue
    else {
      if (closed || character === '"') failure('PARSE_ERROR', 'Malformed CSV export')
      cell += character
    }
  }
  if (quoted) failure('TRUNCATED_RESPONSE', 'CSV export ended inside a quoted field')
  if (cell || row.length) { row.push(cell); rows.push(row) }
  if (!rows.length) failure('PARSE_ERROR', 'CSV export is empty')
  return rows
}
