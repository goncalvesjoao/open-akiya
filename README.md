# open-akiya

Discover Japan’s vacant homes, freely.

Open Akiya makes public Japanese akiya listings easier for anyone to explore. It brings listings from local akiya banks onto a shared map, with translated details, available property information, and links back to the original sources.

The goal is simple: make information that is already public easier to find and understand, without a subscription. Built openly, with contributions welcome from developers, translators, and local communities.

## Development

The foundation uses React, TypeScript, Vite, and Supabase. The current app is a responsive landing page; the interactive map and listing ingestion are future work.

Requires Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The landing page runs without Supabase credentials.

To connect a backend, copy `.env.example` to `.env.local`, then set:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Only public browser credentials belong in `VITE_` variables. Never use a secret or service-role key here. See [Supabase setup](supabase/README.md) for applying the database migration. The optional client lives in `src/lib/supabase.ts` and is `null` until both variables are configured.

```sh
npm run lint       # ESLint
npm run format     # Format with Prettier
npm run format:check # Check Prettier formatting
npm run build      # TypeScript checks and production build
npm run preview    # Serve the production build locally
```

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
