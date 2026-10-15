# Database

Supabase CLI owns schema migration execution and the `supabase_migrations.schema_migrations` history. The CLI is pinned in the npm development dependencies, and the local configuration is committed in `config.toml`.

For local development, install Node.js and Docker, run `npm install`. Configure the server-only `DATABASE_URL` and installation session token as described in [local runtime setup](../docs/local-import-runtime.md). `npm run backend:dev` starts local Supabase, applies pending migrations to the configured local-stack database URL, then starts the API/worker pair. Run `npm run frontend:dev` separately for the browser app. Ctrl+C stops the API/worker pair; stop retained Supabase containers with `npx supabase stop`. `npm run db:migrate` directly runs `supabase migration up --local`, targeting the standard local Supabase stack without reading `.env.local`. For an alternate database, export its URL and run `npx supabase migration up --db-url "$DATABASE_URL"`; startup and the test harness also invoke the CLI directly with their configured URLs. No application migration wrapper or ledger is used.

The first migration creates `public.listings`, preserving Japanese originals, source attribution, yen prices and editorial publication state. Null prices mean unknown, not free. The runtime migration adds normalized listing fields and private jobs, requests, observations and projections.

Row-level security permits browser clients to read only published listings. Imported draft offers are available through the approved local API projection. Private operational tables and source evidence are inaccessible to browser roles, and browser writes are not granted. Privileged database credentials remain server-side.

Existing databases created by the earlier application migration runner need the [verified-history transition](../docs/local-import-runtime.md#transition-from-the-earlier-application-migration-runner) before startup. Do not reset retained data to reconcile migration history. The same document explains isolated database tests and backup considerations.
