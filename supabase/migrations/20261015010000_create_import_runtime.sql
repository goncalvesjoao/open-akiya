-- Local imports retain their private evidence separately from editorial publication.
create schema import_runtime;
revoke all on schema import_runtime from public, anon, authenticated;

alter table public.listings
  add column transaction_type text not null default 'unknown'
    check (transaction_type in ('sale', 'rent', 'both', 'unknown')),
  add column rent_monthly_jpy bigint check (rent_monthly_jpy between 0 and 9007199254740991),
  add column price_note_ja text,
  add column property_type text,
  add column floor_area_m2 numeric check (floor_area_m2 > 0 and floor_area_m2 <> 'NaN'::numeric and floor_area_m2 <> 'Infinity'::numeric),
  add column land_area_m2 numeric check (land_area_m2 > 0 and land_area_m2 <> 'NaN'::numeric and land_area_m2 <> 'Infinity'::numeric),
  add column municipality_id text,
  add column availability text not null default 'unknown'
    check (availability in ('available', 'under_offer', 'unavailable', 'unknown')),
  add column location jsonb,
  add column first_seen_at timestamptz,
  add column last_seen_at timestamptz;

-- Legacy coordinates have no verification evidence. Unknown dates remain null.
update public.listings set location = case
  when latitude is not null then jsonb_build_object(
    'kind', 'unverified', 'point', jsonb_build_object('latitude', latitude, 'longitude', longitude),
    'precision', 'unknown', 'sourceId', 'legacy')
  else '{"kind":"unknown"}'::jsonb end;

create table import_runtime.jobs (
  id text primary key,
  document jsonb not null,
  area jsonb not null,
  scope_key text not null,
  config jsonb not null,
  lease_owner text,
  lease_until timestamptz
);
create table import_runtime.requests (
  idempotency_key text primary key,
  id text not null unique,
  input jsonb not null,
  job_id text not null references import_runtime.jobs(id),
  created_at timestamptz not null default now()
);
create table import_runtime.source_tasks (
  job_id text not null references import_runtime.jobs(id),
  source_id text not null,
  document jsonb not null,
  primary key (job_id, source_id)
);
create table import_runtime.projections (
  listing_id uuid primary key references public.listings(id),
  document jsonb not null
);
create table import_runtime.observations (
  source_id text not null,
  external_id text not null,
  listing_id uuid not null references public.listings(id),
  document jsonb not null,
  content_hash text not null,
  primary key (source_id, external_id)
);
create table import_runtime.coverage (
  scope_key text primary key,
  document jsonb not null
);
create table import_runtime.checkpoints (
  scope_key text not null,
  source_id text not null,
  document jsonb not null,
  primary key (scope_key, source_id)
);

create function import_runtime.protect_job_input()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.area is distinct from old.area or new.scope_key is distinct from old.scope_key
     or new.config is distinct from old.config then
    raise exception 'Import job input is immutable';
  end if;
  return new;
end;
$$;
create trigger immutable_job_input before update on import_runtime.jobs
  for each row execute function import_runtime.protect_job_input();

-- No browser role can inspect operational state or raw source observations.
alter table import_runtime.jobs enable row level security;
alter table import_runtime.requests enable row level security;
alter table import_runtime.source_tasks enable row level security;
alter table import_runtime.projections enable row level security;
alter table import_runtime.observations enable row level security;
alter table import_runtime.coverage enable row level security;
alter table import_runtime.checkpoints enable row level security;
revoke all on all tables in schema import_runtime from public, anon, authenticated;
revoke all on all functions in schema import_runtime from public, anon, authenticated;
alter default privileges in schema import_runtime revoke all on tables from public, anon, authenticated;
alter default privileges in schema import_runtime revoke all on functions from public, anon, authenticated;
