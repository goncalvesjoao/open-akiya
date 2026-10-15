# Database

The first migration creates `public.listings`, with Japanese originals, optional English translations, source attribution, location, yen prices, publication state, and timestamps. Null prices mean unknown, not free. Coordinates may be omitted together.

Row-level security permits browser clients to read only published listings. No browser write policies are provided. Ingestion and moderation should run in trusted backend code; never expose a Supabase secret or service-role key in the frontend.

To use a hosted Supabase project:

1. Create a project in Supabase.
2. Run `migrations/20261015000000_create_listings.sql` in its SQL Editor once. Alternatively, install the Supabase CLI, run `supabase init`, `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, then `supabase db push` from the repository root.
3. Copy the project URL and publishable API key into the root `.env.local` file, using `.env.example` as a template.
4. Restart the Vite development server after changing environment variables.

The landing page does not query the database yet. There are no real listings, ingestion jobs, or translation services included in this foundation.

For local Supabase development, install the Supabase CLI and Docker, run `supabase init`, `supabase start`, then `supabase db reset`. Use the local API URL and public key printed by the CLI. `db reset` recreates the local database and applies the migrations.
