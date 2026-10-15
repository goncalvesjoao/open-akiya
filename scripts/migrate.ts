import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
// Supabase CLI is the only migration executor and history owner.
const root = fileURLToPath(new URL('../', import.meta.url))
const cli = fileURLToPath(
  new URL('../node_modules/supabase/dist/supabase.js', import.meta.url),
)
const child = spawn(
  process.execPath,
  [cli, 'migration', 'up', '--db-url', process.env.DATABASE_URL],
  { cwd: root, stdio: 'inherit' },
)
const code = await new Promise<number | null>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', resolve)
})
process.exitCode = code ?? 1
