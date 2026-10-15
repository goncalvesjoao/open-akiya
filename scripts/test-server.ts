import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    'Set TEST_DATABASE_URL to a local privileged Postgres connection; the suite creates and removes a separate test database.',
  )
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
const name = `open_akiya_test_${randomUUID().replaceAll('-', '')}`
const url = new URL(process.env.TEST_DATABASE_URL)
url.pathname = '/' + name
const root = fileURLToPath(new URL('../', import.meta.url))
async function run(args: string[]) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: url.href,
      TEST_DATABASE_URL: url.href,
    },
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error('Database check failed')
}
try {
  // The generated name contains only ASCII letters, digits and underscores.
  await admin.query(`create database ${name}`)
  await run(['--import', 'tsx', 'scripts/migrate.ts'])
  const testPool = new pg.Pool({ connectionString: url.href })
  try {
    const { readFile } = await import('node:fs/promises')
    await testPool.query(
      await readFile(
        new URL('../supabase/tests/import_runtime.sql', import.meta.url),
        'utf8',
      ),
    )
  } finally {
    await testPool.end()
  }
  await run([
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.server.config.ts',
  ])
} finally {
  await admin.query(`drop database if exists ${name} with (force)`)
  await admin.end()
}
