import assert from 'node:assert/strict'
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
  await run([
    'node_modules/supabase/dist/supabase.js',
    'migration',
    'up',
    '--db-url',
    url.href,
  ])
  const testPool = new pg.Pool({ connectionString: url.href })
  try {
    const history = await testPool.query(
      "select to_regclass('supabase_migrations.schema_migrations') as official, to_regclass('public.local_import_migrations') as legacy",
    )
    assert.ok(
      history.rows[0].official,
      'Supabase CLI must own migration history',
    )
    assert.equal(
      history.rows[0].legacy,
      null,
      'Fresh databases must not create a custom migration ledger',
    )
    const saved = await testPool.query(
      "insert into public.listings(source_url,source_name,title_ja,prefecture,price_jpy,status) values('https://example.invalid/migration-preserved','Fixture','保持する元情報','京都府',0,'draft') returning id",
    )
    await run([
      'node_modules/supabase/dist/supabase.js',
      'migration',
      'up',
      '--db-url',
      url.href,
    ])
    const retained = await testPool.query(
      'select title_ja,price_jpy,status,source_checked_at from public.listings where id=$1',
      [saved.rows[0].id],
    )
    assert.deepEqual(
      retained.rows,
      [
        {
          title_ja: '保持する元情報',
          price_jpy: '0',
          status: 'draft',
          source_checked_at: null,
        },
      ],
      'Repeating CLI migrations must preserve existing listing data',
    )
    const versions = await testPool.query(
      'select version from supabase_migrations.schema_migrations',
    )
    assert.ok(versions.rows.some((row) => row.version === '20261015000000'))
    assert.ok(versions.rows.some((row) => row.version === '20261015010000'))
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
