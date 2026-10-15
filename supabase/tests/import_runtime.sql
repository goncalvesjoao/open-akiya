-- Run after both migrations with a privileged local connection, ON_ERROR_STOP=1.
begin;
do $$
declare
  relation regclass;
begin
  foreach relation in array array[
    'import_runtime.jobs'::regclass, 'import_runtime.requests'::regclass,
    'import_runtime.source_tasks'::regclass, 'import_runtime.observations'::regclass,
    'import_runtime.projections'::regclass, 'import_runtime.coverage'::regclass,
    'import_runtime.checkpoints'::regclass
  ] loop
    if has_table_privilege('anon', relation, 'SELECT')
       or has_table_privilege('authenticated', relation, 'SELECT') then
      raise exception 'Operational relation is exposed: %', relation;
    end if;
    if not (select relrowsecurity from pg_class where oid = relation) then
      raise exception 'RLS missing on %', relation;
    end if;
  end loop;
  if has_schema_privilege('anon', 'import_runtime', 'USAGE') then
    raise exception 'Private schema is exposed';
  end if;
end;
$$;
insert into import_runtime.jobs values ('test-job', '{}', '{"radiusKm":5}', 'scope', '{}', null, null);
insert into import_runtime.requests (idempotency_key,id,input,job_id)
  values ('retry-key','request','{}','test-job');
do $$
begin
  begin
    update import_runtime.jobs set area = '{"radiusKm":9}' where id = 'test-job';
    raise exception 'Mutation unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Import job input is immutable' then raise; end if;
  end;
  begin
    insert into import_runtime.requests (idempotency_key,id,input,job_id)
      values ('retry-key','different-request','{}','test-job');
    raise exception 'Duplicate idempotency key unexpectedly succeeded';
  exception when unique_violation then null;
  end;
end;
$$;
insert into public.listings(source_url,source_name,title_ja,prefecture,status,price_jpy)
  values ('https://example.invalid/preserved','Fixture','元の題名','京都府','published',0);
do $$
begin
  if not exists(select from public.listings where source_url = 'https://example.invalid/preserved'
    and status = 'published' and price_jpy = 0 and source_checked_at is null
    and availability = 'unknown') then
    raise exception 'Existing editorial fields or unknown times changed';
  end if;
end;
$$;
set local role anon;
select id from public.listings where source_url = 'https://example.invalid/preserved';
reset role;
insert into public.listings(source_url,source_name,title_ja,prefecture,status)
  values ('https://example.invalid/private-import','Fixture','非公開の元情報','','draft');
do $$
declare browser_role text;
begin
  foreach browser_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', browser_role);
    begin
      perform * from import_runtime.observations;
      raise exception 'Browser role read private evidence';
    exception when insufficient_privilege then null;
    end;
    if exists(select from public.listings where source_url='https://example.invalid/private-import') then
      raise exception 'Browser role read unpublished import';
    end if;
    begin
      insert into public.listings(source_url,source_name,title_ja,prefecture)
        values ('https://example.invalid/forbidden','Fixture','禁止','');
      raise exception 'Browser role wrote imported data';
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
end;
$$;
rollback;
