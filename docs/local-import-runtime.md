# Local synthetic import runtime

This milestone runs a local API and independent worker backed by your installation's Postgres. It imports clearly labelled synthetic fixtures, never live akiya banks. The map remains independently usable; browser import controls, cache reuse and continuation are later milestones.

Install Node.js 22.12+ and npm, Docker, and the Supabase CLI. Start Docker and run `supabase init` once if your checkout does not yet have `supabase/config.toml`, then `supabase start`. Docker must be available to your account. Supabase prints its local Postgres connection URL. No hosted project is required.

```sh
npm install
cp .env.example .env.local
```

Set these server-only entries in `.env.local` using the local database URL printed by Supabase:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
INSTALLATION_SESSION_TOKEN=replace-with-a-random-secret-of-at-least-32-characters
```

Generate a token with `openssl rand -hex 32`. Keep it in your local environment file. Never prefix the database URL or session token with `VITE_`, commit them, or place them in browser bundles. The runtime uses a privileged database connection to private operational tables; browsers cannot read those tables directly.

```sh
npm run dev:local
```

This command applies pending migrations, then starts Vite, the loopback API and a separate worker process. The worker continues when a browser tab closes. Stopping this command stops the processes; saved queued jobs and committed offers remain in Postgres. Restarting processes preserves the idempotency mapping. Recovery of an interrupted running job is implemented by ticket #18. One installation executes one import at a time.

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

Run `npm test`, `npm run build`, `npm run lint` and `npm run format:check`. `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:server` creates a uniquely named throwaway database, migrates it, checks database-role security and runs the HTTP API/worker suite, then drops only that database. The connection must allow database creation, and the cluster must contain Supabase roles `anon` and `authenticated`. For a standalone development Postgres cluster, create these roles without login first. The supplied database itself is not truncated. No automated checks need live bank access.

Migration records are transactional. `npm run dev:local` also recognizes versions already applied by Supabase's migration ledger. Back up your database before deleting Docker volumes or running `supabase db reset`: those operations erase retained jobs and offers. A missing source configuration is an explicit configuration failure rather than a successful empty search. Fixture mode is intended for deterministic development and does not claim live-source permission or production coverage.

The process startup smoke was verified on 2026-10-15 using a separate PostgreSQL 18.6 database and `DATABASE_URL=… INSTALLATION_SESSION_TOKEN=… node --import tsx scripts/start.ts`. The API, worker and Vite ran as separate children; the documented create/poll/results sequence returned HTTP 202, then `succeeded` with `discovered:1`, `checked:1`, `added:1`, and one saved listing. Stopping the launcher terminated its children. The repeatable API, exclusivity and security evidence lives in `server/runtime.test.ts` and `supabase/tests/import_runtime.sql`; the throwaway-database command above runs both.
