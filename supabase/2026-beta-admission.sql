-- Invited-beta admission gate (version 2026-beta-admission)
-- ---------------------------------------------------------------------------
-- NOT part of the normal release order. Do not run this while applying
-- 2026-per-account-isolation.sql or 2026-ai-api-quotas.sql.
--
-- Applying this file inserts public.beta_config.mode = 'beta' when no row
-- exists yet. In beta mode, public.beta_access_allowed(uid) is true only for
-- rows in public.beta_admissions. An empty list, a missing config row, a null
-- uid, or any other mode denies access (fail closed). Re-running does not
-- change an existing mode and does not delete admissions.
--
-- This script does not create auth users, does not insert a real family, and
-- does not launch a beta. Admit users later with the procedure in
-- docs/runbooks/beta-admission.md. The intended cohort is 50 to 200 families.
-- The trigger rejects the 201st row. The service-role key bypasses row level
-- security, so the API must call beta_access_allowed as well. Unset BETA_MODE
-- does not skip that call. BETA_MODE=off is not an open switch.
--
-- Run the whole file in the Supabase SQL editor for one project. The
-- transaction commits only if every step succeeds. Back up first. Then run
-- supabase/verify-beta-admission.sql.
-- ---------------------------------------------------------------------------

begin;

do $beta$
begin
  if to_regclass('public.records') is null then
    raise exception 'public.records does not exist; apply account isolation before the beta gate';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'records' and c.relrowsecurity
  ) then
    raise exception 'public.records row level security is off';
  end if;

  create table if not exists public.beta_config (
    id integer primary key check (id = 1),
    mode text not null check (mode in ('beta', 'open')),
    updated_at timestamptz not null default now()
  );

  insert into public.beta_config (id, mode)
  values (1, 'beta')
  on conflict (id) do nothing;

  create table if not exists public.beta_admissions (
    user_id uuid primary key,
    admitted_at timestamptz not null default now()
  );

  alter table public.beta_config enable row level security;
  alter table public.beta_admissions enable row level security;
  revoke all on table public.beta_config from public, anon, authenticated;
  revoke all on table public.beta_admissions from public, anon, authenticated;
end
$beta$;

create or replace function public.beta_admissions_enforce_cap()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(842017);
  if new.user_id is null or new.user_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'beta admission refused: nil user id';
  end if;
  if (select count(*) from public.beta_admissions) >= 200 then
    raise exception 'beta admission cap is 200 families';
  end if;
  return new;
end;
$$;

drop trigger if exists beta_admissions_cap on public.beta_admissions;
create trigger beta_admissions_cap
  before insert on public.beta_admissions
  for each row execute function public.beta_admissions_enforce_cap();

create or replace function public.beta_access_allowed(uid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m text;
  caller text;
begin
  caller := auth.role();
  if caller is distinct from 'service_role' and caller is distinct from 'authenticated' then
    return false;
  end if;
  if caller = 'authenticated' and uid is distinct from auth.uid() then
    return false;
  end if;
  if uid is null or uid = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  select mode into m from public.beta_config where id = 1;
  if m is null then
    return false;
  end if;
  if m = 'open' then
    return true;
  end if;
  if m = 'beta' then
    return exists (select 1 from public.beta_admissions where user_id = uid);
  end if;
  return false;
end;
$$;

revoke all on function public.beta_access_allowed(uuid) from public, anon;
grant execute on function public.beta_access_allowed(uuid) to authenticated, service_role;

-- Same helper the isolation migration installs. Replacing it here keeps the
-- beta predicate if isolation is applied again afterwards: that rerun delegates
-- to beta_access_allowed whenever the function exists.
create or replace function public.sync_access_allowed(uid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.beta_access_allowed(uid);
end;
$$;

revoke all on function public.sync_access_allowed(uuid) from public, anon;
grant execute on function public.sync_access_allowed(uuid) to authenticated, service_role;

do $policies$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'records'
  loop
    execute format('drop policy if exists %I on public.records', pol.policyname);
  end loop;

  for pol in
    select policyname, coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
  loop
    if pol.qual ilike '%blobs%'
       or pol.with_check ilike '%blobs%'
       or pol.policyname ilike '%blob%'
    then
      execute format('drop policy if exists %I on storage.objects', pol.policyname);
    end if;
  end loop;

  create policy "records owner select" on public.records
    for select using (auth.uid() = owner and public.sync_access_allowed(auth.uid()));

  create policy "records owner insert" on public.records
    for insert with check (auth.uid() = owner and public.sync_access_allowed(auth.uid()));

  create policy "records owner update" on public.records
    for update using (auth.uid() = owner and public.sync_access_allowed(auth.uid()))
    with check (auth.uid() = owner and public.sync_access_allowed(auth.uid()));

  create policy "records owner delete" on public.records
    for delete using (auth.uid() = owner and public.sync_access_allowed(auth.uid()));

  create policy "blobs owner select" on storage.objects
    for select using (
      bucket_id = 'blobs'
      and (storage.foldername(name))[1] = auth.uid()::text
      and public.sync_access_allowed(auth.uid())
    );

  create policy "blobs owner insert" on storage.objects
    for insert with check (
      bucket_id = 'blobs'
      and (storage.foldername(name))[1] = auth.uid()::text
      and public.sync_access_allowed(auth.uid())
    );

  create policy "blobs owner update" on storage.objects
    for update using (
      bucket_id = 'blobs'
      and (storage.foldername(name))[1] = auth.uid()::text
      and public.sync_access_allowed(auth.uid())
    ) with check (
      bucket_id = 'blobs'
      and (storage.foldername(name))[1] = auth.uid()::text
      and public.sync_access_allowed(auth.uid())
    );

  create policy "blobs owner delete" on storage.objects
    for delete using (
      bucket_id = 'blobs'
      and (storage.foldername(name))[1] = auth.uid()::text
      and public.sync_access_allowed(auth.uid())
    );
end
$policies$;

commit;
