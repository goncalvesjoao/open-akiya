import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  // Serialize startup migrations across API/worker installations using this database.
  await client.query('select pg_advisory_lock(1329678671)')
  await client.query(`create table if not exists public.local_import_migrations (
    name text primary key, applied_at timestamptz not null default now()
  )`)
  await client.query(
    'alter table public.local_import_migrations enable row level security',
  )
  await client.query(
    'revoke all on public.local_import_migrations from public, anon, authenticated',
  )
  const directory = fileURLToPath(
    new URL('../supabase/migrations/', import.meta.url),
  )
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const applied = await client.query(
      'select name from public.local_import_migrations where name = $1',
      [name],
    )
    if (applied.rowCount) continue
    // Supabase CLI may already have applied the foundation migration.
    const supabaseApplied = await client.query(
      "select to_regclass('supabase_migrations.schema_migrations') as ledger",
    )
    if (supabaseApplied.rows[0].ledger) {
      const version = name.split('_')[0]
      const existing = await client.query(
        'select version from supabase_migrations.schema_migrations where version = $1',
        [version],
      )
      if (existing.rowCount) {
        await client.query(
          'insert into public.local_import_migrations(name) values ($1)',
          [name],
        )
        continue
      }
    }
    await client.query('begin')
    try {
      await client.query(await readFile(`${directory}/${name}`, 'utf8'))
      await client.query(
        'insert into public.local_import_migrations(name) values ($1)',
        [name],
      )
      await client.query('commit')
      console.log(`Applied ${name}`)
    } catch (error) {
      await client.query('rollback')
      throw error
    }
  }
} finally {
  await client.query('select pg_advisory_unlock(1329678671)')
  client.release()
  await pool.end()
}
