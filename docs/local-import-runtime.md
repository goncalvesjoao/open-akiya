# Local synthetic import runtime

This milestone runs a local API and independent worker backed by your installation's Postgres. It imports clearly labelled synthetic fixtures, never live akiya banks. The map remains independently usable; browser import controls, cache reuse and continuation are later milestones.

Install Node.js 22.12+, npm and Docker. `npm install` includes the pinned Supabase CLI; the repository already contains `supabase/config.toml`. Docker must be available to your account for the local Supabase stack. No hosted project or CLI login is required.

```sh
npm install
npx supabase start
cp .env.example .env.local
```

Set these server-only entries in `.env.local` using the local database URL printed by Supabase:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable
INSTALLATION_SESSION_TOKEN=replace-with-a-random-secret-of-at-least-32-characters
```

Supabase prints its local database URL. Append `?sslmode=disable` for this local, unencrypted database; keep TLS enabled for database connections that require it. A standalone local Postgres with the Supabase roles can also run the migrations and tests without Docker; Docker is needed to start the full Supabase stack.

Generate a token with `openssl rand -hex 32`. Keep it in your local environment file. Never prefix the database URL or session token with `VITE_`, commit them, or place them in browser bundles. The runtime uses a privileged database connection to private operational tables; browsers cannot read those tables directly.

```sh
npm run dev:local
```

This npm command loads `.env.local` through the pinned `dotenv-cli`, then invokes the pinned Supabase CLI with the explicit `DATABASE_URL`. Only after migrations succeed does `concurrently` start Vite, the loopback API and a separate worker with named output. Ctrl+C or any service exit stops its peers. The frontend uses strict port 5173 to match the allowed origins. A missing database URL stops startup; the API validates the installation session token and a validation failure stops the service group. The worker continues when a browser tab closes. Stopping this command stops the processes; saved queued jobs and committed offers remain in Postgres. Restarting processes preserves the idempotency mapping. Recovery of an interrupted running job is implemented by ticket #18. One installation executes one import at a time.

The API listens on `127.0.0.1:8787`. Allowed browser origins are `http://localhost:5173` and `http://127.0.0.1:5173`. Mutation calls require an allowed Origin, the installation token, JSON content type and, for create, an idempotency key. Repeating the same key and semantic input returns the saved request; reusing it with different input is a conflict.

## API smoke journey

Load your token into your shell without printing it, then create a synthetic import:

```sh
read -rsp 'Installation token: ' INSTALLATION_SESSION_TOKEN; echo
export INSTALLATION_SESSION_TOKEN
curl -sS http://127.0.0.1:8787/api/import-requests \
  -H 'Origin: http://127.0.0.1:5173' \
  -H "X-Installation-Session: $INSTALLATION_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-smoke-1' \
  --data '{"area":{"center":{"latitude":35,"longitude":135},"radiusKm":5},"intent":"import"}'
```

Use the returned request/job IDs to inspect durable progress at `GET /api/import-requests/:id` and `GET /api/import-jobs/:id`. This slice exposes queued, running, succeeded, partial and failed jobs. Counts report discoveries, checks, additions, updates, unchanged offers and rejected records; they do not imply exhaustive inventory.

Cancellation belongs to ticket #17 and is not exposed by this slice. Read saved listings with `POST /api/area-results`, the same headers and `{"area":{"center":{"latitude":35,"longitude":135},"radiusKm":5},"showUnavailable":false}`. Explicitly unavailable offers require `showUnavailable:true`; a failed check or omitted offer does not withdraw saved data.

The API sends approved listing fields and sanitized errors only. Raw observations, content hashes, stack traces, leases and credentials remain server-side. Imports preserve editorial publication status and Japanese originals. Sale/rent identities remain separate; unknown prices remain null and explicit free offers remain zero.

## Verification and recovery

Run `npm test`, `npm run build`, `npm run lint` and `npm run format:check`. `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable npm run test:server` creates a uniquely named throwaway database, applies the same Supabase CLI migrations twice, verifies official history and preservation of saved listing data, checks database-role security and runs the HTTP API/worker suite, then drops only that database. The connection must allow database creation, and the cluster must contain Supabase roles `anon` and `authenticated`. For a standalone development Postgres cluster, create these roles without login first. The supplied database itself is not truncated. No automated checks need live bank access.

Supabase CLI exclusively executes migrations and records their history in `supabase_migrations.schema_migrations`. Startup and the test harness invoke the pinned CLI directly with their explicit database URLs. `npm run db:migrate` directly runs `supabase migration up --local` for the standard local Supabase stack; it does not read `.env.local`. To migrate an alternate Postgres, export its URL in your shell and run `npx supabase migration up --db-url "$DATABASE_URL"`. There is no application migration ledger. A repeat run leaves already applied migrations and saved data unchanged. Back up your database before deleting Docker volumes or running `supabase db reset`: those operations erase retained jobs and offers. A missing source configuration is an explicit configuration failure rather than a successful empty search. Fixture mode is intended for deterministic development and does not claim live-source permission or production coverage.

The earlier process launcher was smoke-tested on 2026-10-15 using a separate PostgreSQL 18.6 database and the former `scripts/start.ts` entrypoint (now removed in favor of npm scripts and `concurrently`). The API, worker and Vite ran as separate children; the documented create/poll/results sequence returned HTTP 202, then `succeeded` with `discovered:1`, `checked:1`, `added:1`, and one saved listing. Stopping that historical launcher terminated its children. The repeatable API, exclusivity and security evidence lives in `server/runtime.test.ts` and `supabase/tests/import_runtime.sql`; the throwaway-database command above runs both.

## Transition from the earlier application migration runner

An existing database may have both schema migrations applied but only `public.local_import_migrations` recording them. Do this reconciliation before starting the application. Retain a database backup and inspect a restored copy first; resetting the database would erase jobs and offers.

Use the same privileged local database URL as the application. Inspect whether each history table exists, then read any existing entries:

```sh
psql "$DATABASE_URL" -c "select to_regclass('public.local_import_migrations'), to_regclass('supabase_migrations.schema_migrations');"
# Run only if the corresponding table exists:
psql "$DATABASE_URL" -c 'select name from public.local_import_migrations order by name;'
npx supabase migration list --db-url "$DATABASE_URL"
```

History entries alone do not prove that a schema is intact. Compare the actual tables, constraints, triggers, functions, grants, RLS settings and policies against each SQL file in `supabase/migrations/`. Check existing listing IDs, Japanese fields, editorial status and saved operational records before and after reconciliation. If an object is missing or differs, investigate and repair that discrepancy before marking its migration applied. Never mark a missing migration as applied merely to bypass a CLI error.

Only for a migration whose complete SQL effects you have verified, and which is absent from the Supabase history, record that exact version using the CLI. Run each command only when its own condition holds:

```sh
# After verifying every effect of 20261015000000_create_listings.sql:
npx supabase migration repair --db-url "$DATABASE_URL" --status applied 20261015000000
# After verifying every effect of 20261015010000_create_import_runtime.sql:
npx supabase migration repair --db-url "$DATABASE_URL" --status applied 20261015010000
```

For example, a database with only the verified first migration needs only the first repair; the CLI then applies the second migration normally. A database already tracked correctly by Supabase needs no repair. After reconciliation, run `npx supabase migration up --db-url "$DATABASE_URL"` against that same inspected database and inspect the official history and saved records again. The old application history table is inert and is not consulted or modified; retain it for audit or remove that table manually after the transition is verified and backed up. Do not remove the listing or import tables.

The transition was checked on a copy of the earlier runner's database on 2026-10-15: both verified versions were repaired, the next CLI migration run applied nothing, and all existing listing, request, job, source-task, observation and projection records remained identical. This is evidence for that inspected fixture database, not permission to mark migrations applied in an uninspected installation.

The pinned CLI migration path was also verified against standalone PostgreSQL 18.6 without Docker: fresh migrations populated only the Supabase history, repeating them preserved saved listing data, and the API/worker/frontend startup smoke still produced a succeeded one-listing import. The pinned CLI also completed a repeated migration run under the documented minimum Node.js 22.12.0.

The replacement `npm run dev:local` path was smoke-tested on 2026-10-15 with temporary `.env.local` files under Node.js 22.12.0 and 26.8.2. Migrations completed before named API/worker/frontend output, and the API returned HTTP 202 followed by a succeeded import and one saved listing. Failed migrations and missing database URLs started no services; a weak session token caused API validation to stop the group. Ctrl+C, a clean API exit and an API bind failure all left no child processes or listeners on ports 8787 and 5173. `dotenv-cli` loads the file once so migration and service commands inherit the same environment; `concurrently --kill-others --success first` propagates the first service's outcome while stopping its peers.
