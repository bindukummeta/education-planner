-- Read-only check of account-isolation state. Run in the Supabase SQL Editor
-- after supabase/2026-per-account-isolation.sql. No inserts, updates, or DDL.
--
-- Every row with ok = false is a rollout blocker, except check_id values that
-- start with info_ (those are counts). This session bypasses RLS, so a green
-- report does not replace the two-account client check in supabase/README.md.

with records_policies as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
  from pg_policies
  where schemaname = 'public' and tablename = 'records'
),
blob_policies as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and (
      coalesce(qual, '') ilike '%blobs%'
      or coalesce(with_check, '') ilike '%blobs%'
      or policyname ilike '%blob%'
    )
),
owner_key as (
  select con.conname, con.contype
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'records'
    and con.contype in ('p', 'u')
    and (
      select array_agg(att.attname order by att.attname)
      from unnest(con.conkey) as cols(attnum)
      join pg_attribute att on att.attrelid = rel.oid and att.attnum = cols.attnum
    ) = array['id', 'owner', 'store']::name[]
)
select check_id, ok, detail
from (
  select
    'owner_not_null'::text as check_id,
    coalesce((
      select a.attnotnull
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'records' and a.attname = 'owner' and not a.attisdropped
    ), false) as ok,
    'public.records.owner is NOT NULL'::text as detail
  union all
  select
    'owner_store_id_unique',
    exists (select 1 from owner_key),
    coalesce((select string_agg(conname || ' (' || contype || ')', ', ') from owner_key), 'missing unique (owner, store, id)')
  union all
  select
    'owner_updated_at_index',
    exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'records'
        and indexname = 'records_owner_updated_at_idx'
    ),
    'index records_owner_updated_at_idx on (owner, updated_at)'
  union all
  select
    'records_rls_enabled',
    coalesce((
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'records'
    ), false),
    'row level security enabled on public.records'
  union all
  select
    'records_policies_owner_only',
    (select count(*) from records_policies) = 4
      and not exists (select 1 from records_policies where cmd = 'ALL')
      and not exists (
        select 1
        from records_policies
        where (cmd in ('SELECT', 'UPDATE', 'DELETE') and (qual not like '%auth.uid()%' or qual not like '%owner%'))
           or (cmd in ('INSERT', 'UPDATE') and (with_check not like '%auth.uid()%' or with_check not like '%owner%'))
           or cmd not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      ),
    (select count(*)::text || ' policies: ' || coalesce(string_agg(policyname || ' ' || cmd, ', ' order by policyname), 'none') from records_policies)
  union all
  select
    'anon_cannot_read_records',
    not has_table_privilege('anon', 'public.records', 'select'),
    'anon select on public.records is revoked'
  union all
  select
    'authenticated_can_write_records',
    has_table_privilege('authenticated', 'public.records', 'select')
      and has_table_privilege('authenticated', 'public.records', 'insert')
      and has_table_privilege('authenticated', 'public.records', 'update')
      and has_table_privilege('authenticated', 'public.records', 'delete'),
    'authenticated keeps DML; RLS still filters by owner'
  union all
  select
    'blob_policies_owner_folder',
    (select count(*) from blob_policies) = 4
      and not exists (select 1 from blob_policies where cmd = 'ALL')
      and (select count(*) from blob_policies where cmd = 'SELECT') = 1
      and (select count(*) from blob_policies where cmd = 'INSERT') = 1
      and (select count(*) from blob_policies where cmd = 'UPDATE') = 1
      and (select count(*) from blob_policies where cmd = 'DELETE') = 1
      and not exists (
        select 1
        from blob_policies
        where (qual || ' ' || with_check) not ilike '%blobs%'
           or (qual || ' ' || with_check) not like '%auth.uid()%'
           or (qual || ' ' || with_check) not like '%foldername%'
      ),
    (select count(*)::text || ' blob policies: ' || coalesce(string_agg(policyname || ' ' || cmd, ', ' order by policyname), 'none') from blob_policies)
  union all
  select
    'blobs_bucket_private',
    coalesce((select not b.public from storage.buckets b where b.id = 'blobs'), false),
    'storage.buckets id blobs is private'
  union all
  select
    'storage_objects_rls_enabled',
    coalesce((
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'storage' and c.relname = 'objects'
    ), false),
    'row level security enabled on storage.objects'
  union all
  select
    'quarantine_rls_and_revoke',
    to_regclass('public.records_legacy_unowned') is not null
      and coalesce((
        select c.relrowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'records_legacy_unowned'
      ), false)
      and not has_table_privilege('anon', 'public.records_legacy_unowned', 'select')
      and not has_table_privilege('authenticated', 'public.records_legacy_unowned', 'select'),
    'legacy quarantine exists, has RLS, and is not selectable by anon or authenticated'
  union all
  select
    'info_quarantine_rows',
    true,
    'records_legacy_unowned rows: ' || (select count(*)::text from public.records_legacy_unowned)
  union all
  select
    'info_root_blob_objects',
    true,
    'root-level blobs objects (no folder): ' || (
      select count(*)::text
      from storage.objects
      where bucket_id = 'blobs' and strpos(name, '/') = 0
    ) || ' — folder policies deny these until a single-family claim or a device re-upload'
) checks
order by check_id;
