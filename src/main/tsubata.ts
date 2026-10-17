import { createHash } from 'node:crypto'
import type { Candidate, NormalizedFields, SourceAdapter } from './adapter'
import type { SelectedArea } from '../shared/listings'
import { LocalApiError } from './errors'
import {
  acquireTsubataSnapshot,
  tsubataExportUrl as TSUBATA_EXPORT,
} from './tsubata-snapshot'
export { TSUBATA_EXPORT }
const version = 'tsubata-csv-v1'
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message: string): never => {
  throw new LocalApiError(409, 'PARSE_ERROR', message, false)
}
// Strict bounded RFC4180 reader. Truncated quoted records and changing headers
// cannot establish a valid export. Nothing follows URLs embedded in cells.
function records(body: unknown): Record<string, string>[] {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 262144)
    fail('CSV missing or exceeds byte budget')
  const text = (body as string).replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let fields: string[] = []
  let cell = ''
  let quoted = false
  let closed = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else cell += c
      continue
    }
    if (c === '"') {
      if (cell || closed) fail('Malformed CSV quote')
      quoted = true
    } else if (c === ',' || c === '\n' || c === '\r') {
      fields.push(cell)
      cell = ''
      closed = false
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++
        rows.push(fields)
        fields = []
        if (rows.length > 1001)
          throw new LocalApiError(
            409,
            'ROW_BUDGET_EXHAUSTED',
            'CSV exceeds acquisition row budget',
          )
      }
    } else {
      if (closed) fail('Malformed CSV closing quote')
      cell += c
    }
  }
  if (quoted)
    throw new LocalApiError(
      409,
      'TRUNCATED_RESPONSE',
      'CSV export ended inside a quoted field',
    )
  if (cell || fields.length || closed) {
    fields.push(cell)
    rows.push(fields)
  }
  if (rows.length > 1001)
    throw new LocalApiError(
      409,
      'ROW_BUDGET_EXHAUSTED',
      'CSV exceeds acquisition row budget',
    )
  const header = rows.shift() ?? []
  const required = [
    '全国地方公共団体コード',
    'ID',
    '構造',
    '契約形態',
    '金額',
    '受付状況',
    '備考',
  ]
  if (
    new Set(header).size !== header.length ||
    required.some((k) => !header.includes(k))
  )
    fail('CSV schema changed')
  return rows
    .filter((r) => r.some(Boolean))
    .map((r) => {
      return r.length !== header.length
        ? { ID: '', invalidRow: 'CSV record width changed' }
        : Object.fromEntries(header.map((k, i) => [k, r[i].trim()]))
    })
}
const identity = (r: Record<string, string>) =>
  `${r['全国地方公共団体コード']}:${r.ID}`
const addressParts = (r: Record<string, string>) =>
  ['所在地_都道府県', '所在地_市区町村', '所在地_町字', '所在地_番地以下'].map(
    (k) => r[k] ?? '',
  )
const witness = (r: Record<string, string>) =>
  hash([addressParts(r), r['構造']])
const variant = (r: Record<string, string>) =>
  r['契約形態'] === '売買'
    ? 'sale'
    : r['契約形態'] === '賃貸'
      ? 'rent'
      : 'unknown'
/** Not enabled by the desktop runtime. A reviewed intersection provider is an
 * explicit dependency; tests supply fictional scope evidence, never real pins. */
export function tsubataAdapter(options?: {
  intersectsMunicipality(area: SelectedArea): boolean
  geographyVersion: string
}): SourceAdapter {
  const snapshot = (context: Parameters<SourceAdapter['fetchDetail']>[1]) =>
    acquireTsubataSnapshot(context, version, records)
  return {
    capabilities: {
      sourceId: 'tsubata-open-data',
      sourceName: '津幡町 空き家バンク（CC BY 4.0）',
      minimumIntervalMs: 10000,
      adapterVersion: version,
      queryVersion: `csv-${options?.geographyVersion ?? 'unsupported'}`,
      geography: options ? 'municipality' : 'unsupported',
      dateOrdering: null,
      cursorVersion: 'full-export-v1',
      allowedHosts: ['www.town.tsubata.lg.jp'],
      allowedUrls: [TSUBATA_EXPORT],
    },
    async discover({ area }, context) {
      if (!options || !options.intersectsMunicipality(area))
        return {
          candidates: [],
          nextCursor: null,
          exhausted: true,
          limitation:
            'Reviewed municipality intersection unavailable; live activation remains blocked',
        }
      const data = await snapshot(context)
      const rows = data.rows
      return {
        caveats: [
          'Coverage is the published municipal export, not complete vacant-home inventory; live activation remains gated',
        ],
        candidates: rows.map((r, i): Candidate => ({
          snapshotFingerprint: data.fingerprint,
          externalId:
            r.ID && r['全国地方公共団体コード'] === '173614'
              ? identity(r)
              : `quarantine:${i}`,
          transactionType: variant(r),
          url: TSUBATA_EXPORT,
          location: { kind: 'municipality', municipalityId: '173614' },
          municipalityId: '173614',
          publishedAt: null,
          modifiedAt: null,
          relevance: 'plausible',
        })),
        nextCursor: null,
        exhausted: true,
        limitation: null,
      }
    },
    async fetchDetail(candidate, context) {
      const data = await snapshot(context)
      const rows = data.rows
      if (
        candidate.snapshotFingerprint &&
        candidate.snapshotFingerprint !== data.fingerprint
      )
        throw new LocalApiError(
          409,
          'SNAPSHOT_INVALID',
          'Saved processing snapshot is no longer compatible',
        )
      context.consumeRow()
      // Yield between records so utility-process cancellation/quit messages
      // can be handled even when one export contains every detail.
      await new Promise<void>((resolve) => setImmediate(resolve))
      context.signal.throwIfAborted()
      let matches = rows.filter(
        (r) =>
          identity(r) === candidate.externalId &&
          variant(r) === candidate.transactionType,
      )
      if (
        matches.length === 1 &&
        rows.some(
          (r) =>
            variant(r) === candidate.transactionType &&
            identity(r) !== candidate.externalId &&
            witness(r) === witness(matches[0]),
        )
      )
        matches = []
      return {
        identity: {
          sourceId: 'tsubata-open-data',
          externalId: candidate.externalId,
        },
        url: TSUBATA_EXPORT,
        fetchedAt: data.fetchedAt,
        payload: matches,
        provenance: {
          snapshot: data.fingerprint,
          license:
            'CC BY 4.0 https://creativecommons.org/licenses/by/4.0/; reviewed 2026-10-15',
          attribution:
            '出典：津幡町「空き家バンク」オープンデータ。Open Akiya にて項目を正規化。',
          source: TSUBATA_EXPORT,
        },
      }
    },
    normalize(evidence) {
      const reject = (message: string) => ({
        kind: 'rejected' as const,
        error: { code: 'PARSE_ERROR', message, retryable: false },
      })
      const rows = evidence.payload as Record<string, string>[]
      if (rows.length !== 1)
        return reject('Missing or duplicate municipal identity; quarantined')
      const r = rows[0]
      const type = variant(r)
      if (
        r['全国地方公共団体コード'] !== '173614' ||
        !/^TBB\d{9}$/.test(r.ID) ||
        type === 'unknown'
      )
        return reject('Missing or ambiguous offer identity')
      // Structure alone (wooden, floors, etc.) does not establish residential use.
      if (
        !/^(木造|鉄骨造|鉄筋コンクリート造)?(\d+階建)?(住宅|居宅)$/.test(
          r['構造'],
        )
      )
        return reject('No affirmative residential building evidence')
      const raw = r['金額']
      const note = r['備考']
      const free = raw === '無料' || (raw === '0' && /^(無償|無料)$/.test(note))
      let amount: number | null = null
      if (free) amount = 0
      else if (raw && !['不明', '応相談', '未定'].includes(raw)) {
        if (!/^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw))
          return reject('Malformed or ambiguous price/unit')
        amount = Number(raw.replaceAll(',', ''))
        if (!Number.isSafeInteger(amount)) return reject('Unsafe yen amount')
      }
      if (type === 'rent' && amount !== null && note !== '金額は月額')
        return reject('Monthly rent evidence missing')
      const address = addressParts(r)
      if (!address.some(Boolean)) return reject('Identity witness unavailable')
      const fields: Partial<NormalizedFields> = {
        titleJa: `津幡町 ${r.ID}`,
        transactionType: type,
        salePriceJpy: type === 'sale' ? amount : null,
        rentMonthlyJpy: type === 'rent' ? amount : null,
        propertyType: '住宅',
        prefecture: r['所在地_都道府県'] || null,
        municipalityId: '173614',
        municipalityNameJa: '津幡町',
        location: { kind: 'municipality' as const, municipalityId: '173614' },
        availability:
          r['受付状況'] === '成約済み'
            ? ('unavailable' as const)
            : r['受付状況'] === '受付中'
              ? ('available' as const)
              : ('unknown' as const),
      }
      return {
        kind: 'accepted',
        observation: {
          identity: evidence.identity,
          url: TSUBATA_EXPORT,
          adapterVersion: version,
          sourceCheckedAt: evidence.fetchedAt,
          fields,
          identityEvidence: {
            fingerprint: witness(r),
            description:
              'Exact municipal address/structure witness; not a temporal identity guarantee',
          },
          provenance: {
            ...evidence.provenance,
            identity: `173614 / ${r.ID} / ${r['契約形態']}`,
            propertyType: r['構造'],
            availability: r['受付状況'],
            ...(amount !== null
              ? {
                  [type === 'sale' ? 'salePriceJpy' : 'rentMonthlyJpy']:
                    `金額=${raw}; ${type === 'rent' ? '月額' : ''}`,
                }
              : {}),
            address: JSON.stringify(address),
          },
          contentHash: hash(fields),
        },
      }
    },
  }
}
