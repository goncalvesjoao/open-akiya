import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { runWorkerOnce } from './worker.ts'
import { createSyntheticAdapter, syntheticTransport } from './synthetic.ts'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
const adapters = [createSyntheticAdapter()]
let stopping = false
process.once('SIGINT', () => {
  stopping = true
})
process.once('SIGTERM', () => {
  stopping = true
})
console.log('Synthetic import worker started')
try {
  while (!stopping) {
    const worked = await runWorkerOnce({
      pool,
      adapters,
      transport: syntheticTransport,
    })
    if (!worked) await setTimeout(250)
  }
} catch {
  console.error(
    'Import worker stopped unexpectedly; restart to recover saved work',
  )
  process.exitCode = 1
} finally {
  await pool.end()
}
