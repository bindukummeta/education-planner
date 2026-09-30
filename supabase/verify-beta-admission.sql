-- Read-only check of the invited-beta gate. Run in the Supabase SQL Editor
-- after supabase/2026-beta-admission.sql. No inserts, updates, or DDL.
--
-- Every row with ok = false is a blocker, except check_id values that start
-- with info_. A green report does not admit a family and does not launch a
-- beta. This session bypasses row level security.

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
cfg as (
  select mode from public.beta_config where id = 1
)
select check_id, ok, detail
from (
  select
    'beta_config_mode'::text as check_id,
    coalesce((select mode in ('beta', 'open') from cfg), false) as ok,
    coalesce((select 'mode=' || mode from cfg), 'public.beta_config row 1 is missing') as detail
  union all
  select
    'admission_cap',
    (select count(*) from public.beta_admissions) <= 200,
    'admitted families ' || (select count(*)::text from public.beta_admissions) || ' (hard cap 200)'
  union all
  select
    'cap_trigger',
    exists (
      select 1
      from pg_trigger
      where tgname = 'beta_admissions_cap' and not tgisinternal
    ),
    'before-insert trigger beta_admissions_cap'
  union all
  select
    'access_function',
    to_regprocedure('public.beta_access_allowed(uuid)') is not null,
    'public.beta_access_allowed(uuid)'
  union all
  select
    'anon_cannot_execute_gate',
    not has_function_privilege('anon', 'public.beta_access_allowed(uuid)', 'execute'),
    'anon execute on beta_access_allowed is revoked'
  union all
  select
    'authenticated_can_execute_gate',
    has_function_privilege('authenticated', 'public.beta_access_allowed(uuid)', 'execute'),
    'authenticated can execute beta_access_allowed for its own uid'
  union all
  select
    'records_policies_call_gate',
    (select count(*) from records_policies) = 4
      and (select count(*) from records_policies where (qual || ' ' || with_check) like '%sync_access_allowed%') = 4
      and exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'sync_access_allowed'
          and pg_get_functiondef(p.oid) ilike '%beta_access_allowed%'
      )
      and not exists (
        select 1 from records_policies
        where (qual || ' ' || with_check) not like '%auth.uid()%'
           or (qual || ' ' || with_check) not like '%owner%'
      ),
    'four owner policies call sync_access_allowed, which calls beta_access_allowed'
  union all
  select
    'blob_policies_call_gate',
    (select count(*) from blob_policies) = 4
      and (select count(*) from blob_policies where (qual || ' ' || with_check) like '%sync_access_allowed%') = 4
      and not exists (
        select 1 from blob_policies
        where (qual || ' ' || with_check) not ilike '%blobs%'
           or (qual || ' ' || with_check) not like '%auth.uid()%'
           or (qual || ' ' || with_check) not like '%foldername%'
      ),
    'four blob folder policies call sync_access_allowed'
  union all
  select
    'admissions_not_readable',
    to_regclass('public.beta_admissions') is not null
      and coalesce((
        select c.relrowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'beta_admissions'
      ), false)
      and not has_table_privilege('anon', 'public.beta_admissions', 'select')
      and not has_table_privilege('authenticated', 'public.beta_admissions', 'select'),
    'beta_admissions has RLS and is not selectable by anon or authenticated'
  union all
  select
    'info_admitted_families',
    true,
    'admitted families: ' || (select count(*)::text from public.beta_admissions)
  union all
  select
    'info_cohort_target',
    true,
    'intended invited cohort is 50 to 200 families while mode is beta; the hard cap is 200'
) checks
order by check_id;
