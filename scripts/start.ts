import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required; see docs/local-import-runtime.md')
if (
  !process.env.INSTALLATION_SESSION_TOKEN ||
  process.env.INSTALLATION_SESSION_TOKEN.length < 32
) {
  throw new Error(
    'INSTALLATION_SESSION_TOKEN must contain at least 32 characters',
  )
}
const root = fileURLToPath(new URL('../', import.meta.url))
const tsx = fileURLToPath(
  new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
)
const migrate = spawn(
  process.execPath,
  [
    'node_modules/supabase/dist/supabase.js',
    'migration',
    'up',
    '--db-url',
    process.env.DATABASE_URL,
  ],
  {
    cwd: root,
    stdio: 'inherit',
  },
)
const migrated = await new Promise<number | null>((resolve, reject) => {
  migrate.once('error', reject)
  migrate.once('exit', resolve)
})
if (migrated !== 0) process.exit(migrated ?? 1)
const children = [
  spawn(process.execPath, [tsx, 'server/main.ts'], {
    cwd: root,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [tsx, 'server/worker-main.ts'], {
    cwd: root,
    stdio: 'inherit',
  }),
  spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'],
    { cwd: root, stdio: 'inherit' },
  ),
]
let stopping = false
function stop(code: number) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill('SIGTERM')
}
process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
for (const child of children) {
  child.once('error', () => stop(1))
  child.once('exit', (code) => stop(code ?? 1))
}
