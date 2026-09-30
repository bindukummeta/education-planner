-- Per-account isolation for EduSync (education-planner-app)
-- ---------------------------------------------------------------------------
-- Run this whole file in Supabase Dashboard → SQL Editor. It is one PL/pgSQL
-- block (no psql \set / variables). It commits only if every step succeeds.
--
-- Before running: back up the database and the blobs bucket. Ship the matching
-- sync.js in the same window (owner column, onConflict owner,store,id, blob
-- paths "<uid>/<id>"). Keep Family Sync closed to additional families until
-- supabase/verify-account-isolation.sql is all ok and the two-account check in
-- supabase/README.md has passed.
--
-- Legacy rows are not assigned to an account unless you explicitly opt in.
-- The previous policies exposed one shared table to every signed-in user, so
-- a NULL owner cannot be split into families safely. Default (both variables
-- below left empty): copy owner-null rows into public.records_legacy_unowned
-- and delete them from the live table. They stay invisible to anon and
-- authenticated. Root-level blob objects are left in place and denied by the
-- folder policies until a device re-uploads them.
--
-- Single-family claim — edit BOTH lines only after a backup, and only if you
-- have confirmed every legacy row and every root-level blobs object belongs
-- to that one auth.users id:
--   legacy_owner_text      := '<that user uuid>';
--   legacy_claim_confirmed := 'single-family';
-- A nil UUID, an unknown user, or a confirmation other than single-family
-- aborts the script. Re-running the default does not pull quarantined rows
-- back and does not change rows that already have an owner.
-- ---------------------------------------------------------------------------

do $isolation$
declare
  legacy_owner_text text := '';
  legacy_claim_confirmed text := '';
  legacy_owner uuid := null;
  claiming boolean := false;
  col_list text;
  select_list text;
  null_count bigint;
  conrec record;
  pol record;
begin
  if to_regclass('public.records') is null then
    raise exception 'public.records does not exist';
  end if;

  if not exists (select 1 from storage.buckets where id = 'blobs') then
    raise exception 'storage bucket blobs does not exist; create a private bucket named blobs first';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity
  ) then
    raise exception 'storage.objects row level security is off; enable it before applying blob policies';
  end if;

  if length(btrim(legacy_owner_text)) > 0 or length(btrim(legacy_claim_confirmed)) > 0 then
    if btrim(legacy_claim_confirmed) is distinct from 'single-family' then
      raise exception 'Legacy claim refused: set legacy_claim_confirmed to single-family only after verifying one family owns every legacy row';
    end if;
    if btrim(legacy_owner_text) = '' or btrim(legacy_owner_text) = '00000000-0000-0000-0000-000000000000' then
      raise exception 'Legacy claim refused: set legacy_owner_text to that family auth.users id (nil UUID is rejected)';
    end if;
    begin
      legacy_owner := btrim(legacy_owner_text)::uuid;
    exception
      when invalid_text_representation then
        raise exception 'Legacy claim refused: legacy_owner_text is not a UUID';
    end;
    if legacy_owner = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception 'Legacy claim refused: nil UUID is not an account';
    end if;
    if not exists (select 1 from auth.users where id = legacy_owner) then
      raise exception 'Legacy claim refused: % is not an auth.users id', legacy_owner;
    end if;
    claiming := true;
  end if;

  alter table public.records
    add column if not exists owner uuid default auth.uid();

  if to_regclass('public.records_legacy_unowned') is null then
    create table public.records_legacy_unowned (like public.records including defaults);
  end if;
  alter table public.records_legacy_unowned
    add column if not exists quarantined_at timestamptz not null default now();
  alter table public.records_legacy_unowned enable row level security;
  revoke all on table public.records_legacy_unowned from public, anon, authenticated;

  select count(*) into null_count from public.records where owner is null;

  if claiming then
    update public.records set owner = legacy_owner where owner is null;
    raise notice 'account isolation: assigned % unowned live rows to %', null_count, legacy_owner;
  else
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into col_list
    from information_schema.columns
    where table_schema = 'public' and table_name = 'records';

    if null_count > 0 then
      execute format(
        'insert into public.records_legacy_unowned (%s) select %s from public.records where owner is null',
        col_list, col_list
      );
      delete from public.records where owner is null;
      raise notice 'account isolation: quarantined % unowned rows in public.records_legacy_unowned (not assigned to any family)', null_count;
    else
      raise notice 'account isolation: no unowned live rows';
    end if;
  end if;

  if exists (select 1 from public.records where owner is null) then
    raise exception 'unowned rows remain in public.records; refusing to set owner NOT NULL';
  end if;

  alter table public.records alter column owner set not null;

  -- Drop uniqueness that is only (store, id) — or a subset of those columns —
  -- so two accounts can store the same local id. Leave any other key alone.
  for conrec in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'records'
      and con.contype in ('p', 'u')
      and not exists (
        select 1
        from unnest(con.conkey) as cols(attnum)
        join pg_attribute att on att.attrelid = rel.oid and att.attnum = cols.attnum
        where att.attname = 'owner'
      )
      and not exists (
        select 1
        from unnest(con.conkey) as cols(attnum)
        join pg_attribute att on att.attrelid = rel.oid and att.attnum = cols.attnum
        where att.attname not in ('store', 'id')
      )
  loop
    execute format('alter table public.records drop constraint %I', conrec.conname);
  end loop;

  if not exists (
    select 1
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
  ) then
    if exists (
      select 1
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'public'
        and rel.relname = 'records'
        and con.contype = 'p'
    ) then
      alter table public.records
        add constraint records_owner_store_id_key unique (owner, store, id);
    else
      alter table public.records
        add constraint records_owner_store_id_pkey primary key (owner, store, id);
    end if;
  end if;

  if claiming then
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into col_list
    from information_schema.columns
    where table_schema = 'public' and table_name = 'records';

    select string_agg(
      case
        when column_name = 'owner' then quote_literal(legacy_owner::text) || '::uuid'
        else quote_ident(column_name)
      end,
      ', ' order by ordinal_position
    )
      into select_list
    from information_schema.columns
    where table_schema = 'public' and table_name = 'records';

    execute format(
      'insert into public.records (%s) select %s from public.records_legacy_unowned on conflict (owner, store, id) do update set data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted where excluded.updated_at >= public.records.updated_at',
      col_list, select_list
    );
    delete from public.records_legacy_unowned;

    -- Do not UPDATE storage.objects directly: changing Storage metadata does
    -- not move the underlying object. Root-level objects remain quarantined by
    -- the folder policies and must be copied through the Storage API or
    -- re-uploaded by an existing device.
    raise notice 'Legacy root-level blob objects were not moved. Copy them through the Storage API or let an existing device re-upload them.';
  end if;

  create index if not exists records_owner_updated_at_idx
    on public.records (owner, updated_at);

  create index if not exists records_owner_updated_at_store_id_idx
    on public.records (owner, updated_at, store, id);

  -- Stable helper so a later rerun of this file does not drop the beta gate.
  -- If 2026-beta-admission.sql has created beta_access_allowed, keep calling it.
  execute $sync_access$
    create or replace function public.sync_access_allowed(uid uuid)
    returns boolean
    language plpgsql
    stable
    security definer
    set search_path = public
    as $body$
    begin
      if to_regprocedure('public.beta_access_allowed(uuid)') is not null then
        return public.beta_access_allowed(uid);
      end if;
      return true;
    end;
    $body$;
  $sync_access$;

  revoke all on function public.sync_access_allowed(uuid) from public, anon;
  grant execute on function public.sync_access_allowed(uuid) to authenticated, service_role;

  alter table public.records enable row level security;
  revoke all on table public.records from public;
  revoke all on table public.records from anon;
  grant select, insert, update, delete on table public.records to authenticated;

  update storage.buckets set public = false where id = 'blobs';

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
$isolation$;
