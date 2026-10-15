# open-akiya

Discover Japan’s vacant homes, freely.

Open Akiya makes public Japanese akiya listings easier for anyone to explore. It brings listings from local akiya banks onto a shared map, with translated details, available property information, and links back to the original sources.

The goal is simple: make information that is already public easier to find and understand, without a subscription. Built openly, with contributions welcome from developers, translators, and local communities.

## Development

The foundation uses React, TypeScript, Vite, and Supabase. The app includes a synthetic listing map and a local synthetic import API/worker backed by Postgres.

Requires Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

For persistent synthetic imports, start Docker and set up the local Supabase stack. The pinned CLI and project configuration are included:

```sh
npx supabase start
cp .env.example .env.local
```

In `.env.local`, set `DATABASE_URL` to the local connection URL with `?sslmode=disable`, and set `INSTALLATION_SESSION_TOKEN` to a random secret of at least 32 characters (`openssl rand -hex 32` generates one). Keep both server-only; never add a `VITE_` prefix.

```sh
npm run dev:local
```

The npm scripts load `.env.local`, apply migrations through Supabase CLI with the configured `DATABASE_URL`, then use `concurrently` to start the loopback frontend, API and independent worker with named output. Ctrl+C or any service exit stops the other services. See [local runtime setup](docs/local-import-runtime.md) for the API journey and existing-database transition.

To apply only migrations to the standard local Supabase stack, run `npm run db:migrate` (`supabase migration up --local`). This command targets that stack and does not read `.env.local`. For an alternate Postgres, export its connection URL in your shell and run the CLI explicitly:

```sh
npx supabase migration up --db-url "$DATABASE_URL"
```

Startup and database tests use their explicit database URLs; no application migration wrapper or ledger is involved.

Open the local URL printed by Vite. The landing page runs without Supabase credentials.

To connect a backend, copy `.env.example` to `.env.local`, then set:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Only public browser credentials belong in `VITE_` variables. Never use a secret or service-role key here. See [Supabase setup](supabase/README.md) for applying the database migration. The optional client lives in `src/lib/supabase.ts` and is `null` until both variables are configured.

```sh
npm test             # Run tests once
npm run test:watch   # Re-run tests as files change
npm run test:server  # Isolated Postgres/API tests; requires TEST_DATABASE_URL
npm run test:e2e     # Run Playwright tests in Chromium
npm run test:e2e:ui  # Open Playwright's interactive test runner
npm run lint         # ESLint
npm run format       # Format with Prettier
npm run format:check # Check Prettier formatting
npm run build        # TypeScript checks and production build
npm run preview      # Serve the production build locally
```

Tests use Vitest with React Testing Library and jsdom. The first test renders the landing page and checks that its contribution link points to the project repository. Add tests alongside the code using `.test.ts` or `.test.tsx` filenames; shared test setup lives in `src/test/setup.ts`.

End-to-end tests live in `e2e/` and use Playwright. Install Chromium once with `npx playwright install chromium`, then run `npm run test:e2e`. Playwright builds the app and starts a local preview server automatically. The landing page test follows the “Meet the project” link and checks that the about section enters the viewport.

The production output is `dist/`, suitable for static hosting. Set the Supabase environment variables before building if the deployment will use the backend. The landing page uses Google Fonts with system font fallbacks.

## Structure

- `src/App.tsx` — landing page and original SVG illustration
- `src/styles.css` — responsive styling
- `src/lib/supabase.ts` — optional browser client
- `supabase/migrations/` — versioned database schema and access policies

## Contributing

Ideas, bug reports, local akiya sources, translations, and code contributions are welcome through [GitHub issues](https://github.com/goncalvesjoao/open-akiya/issues) and pull requests. Keep source attribution and the Japanese originals when adding listing support. Check source terms and reuse permissions before collecting or republishing data.

See the [implementation plan](docs/implementation-plan.md) for parallel workstreams, shared contracts, and integration gates for the map and local area imports.

## License

[MIT](LICENSE). The project’s license covers its code; third-party listings and images retain their respective rights.
