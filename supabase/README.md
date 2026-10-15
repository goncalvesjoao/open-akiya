# Database

Supabase CLI owns schema migration execution and the `supabase_migrations.schema_migrations` history. The CLI is pinned in the npm development dependencies, and the local configuration is committed in `config.toml`.

For local development, install Node.js and Docker, run `npm install`, then `npx supabase start`. Configure the server-only `DATABASE_URL` and installation session token as described in [local runtime setup](../docs/local-import-runtime.md). `npm run dev:local` applies pending migrations through the CLI and starts the application processes. `npm run db:migrate` applies only pending migrations to that configured database. These commands use an explicit database URL; they do not link or push to a hosted project.

The first migration creates `public.listings`, preserving Japanese originals, source attribution, yen prices and editorial publication state. Null prices mean unknown, not free. The runtime migration adds normalized listing fields and private jobs, requests, observations and projections.

Row-level security permits browser clients to read only published listings. Imported draft offers are available through the approved local API projection. Private operational tables and source evidence are inaccessible to browser roles, and browser writes are not granted. Privileged database credentials remain server-side.

Existing databases created by the earlier application migration runner need the [verified-history transition](../docs/local-import-runtime.md#transition-from-the-earlier-application-migration-runner) before startup. Do not reset retained data to reconcile migration history. The same document explains isolated database tests and backup considerations.
