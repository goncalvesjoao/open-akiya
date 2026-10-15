import pg from 'pg'
import { createRuntime } from './runtime.ts'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sessionToken = process.env.INSTALLATION_SESSION_TOKEN
if (!sessionToken || sessionToken.length < 32)
  throw new Error('A strong INSTALLATION_SESSION_TOKEN is required')
const runtime = await createRuntime({
  pool,
  sessionToken,
  allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  port: 8787,
})
console.log(`Synthetic import API: ${runtime.url}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await runtime.close()
  await pool.end()
}
process.once('SIGINT', () => {
  void close()
})
process.once('SIGTERM', () => {
  void close()
})
