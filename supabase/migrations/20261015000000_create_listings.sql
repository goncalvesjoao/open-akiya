-- Published listings are public; ingestion and editorial writes stay server-side.
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  source_url text not null unique check (source_url ~ '^https?://'),
  source_name text not null,
  title_ja text not null,
  title_en text,
  description_ja text,
  description_en text,
  prefecture text not null,
  municipality text,
  price_jpy bigint check (price_jpy >= 0),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  source_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coordinates_together check ((latitude is null) = (longitude is null))
);

create index listings_published_prefecture_idx
  on public.listings (prefecture) where status = 'published';

alter table public.listings enable row level security;
revoke all on table public.listings from anon, authenticated;
grant select on table public.listings to anon, authenticated;

create policy "Anyone can read published listings"
  on public.listings for select to anon, authenticated
  using (status = 'published');

create function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger listings_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();
