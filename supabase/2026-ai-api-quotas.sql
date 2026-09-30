-- Distributed AI API quotas (education-planner-app)
-- ---------------------------------------------------------------------------
-- Version: 2026-ai-api-quotas. Apply once in the Supabase SQL Editor with the
-- same release as the API handlers that call these RPCs. This is not an
-- in-memory limiter: counters and homework-analysis leases live in Postgres
-- and are shared by every serverless instance.
--
-- Trust boundary: these functions are SECURITY DEFINER and can change any
-- account's counters. Execute is granted only to service_role, and each
-- function returns without writing unless auth.role() is service_role.
-- Limits are arguments from the API process, which reads them from its own
-- environment. Do not grant execute to anon or authenticated, and do not let
-- a user JWT supply the limits. The browser anon key cannot execute them.
-- Windows are the clock minute and the UTC day.
-- A homework lease expires on its own if a function is killed before release.
-- Re-running this script replaces the functions and does not delete counters.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

create table if not exists public.ai_quota_counters (
  bucket text primary key,
  hits integer not null check (hits >= 0),
  expires_at timestamptz not null
);

create table if not exists public.ai_analysis_leases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null,
  expires_at timestamptz not null
);

create index if not exists ai_analysis_leases_user_endpoint_idx
  on public.ai_analysis_leases (user_id, endpoint);

alter table public.ai_quota_counters enable row level security;
alter table public.ai_analysis_leases enable row level security;

revoke all on table public.ai_quota_counters from public, anon, authenticated;
revoke all on table public.ai_analysis_leases from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_quota_counters to service_role;
grant select, insert, update, delete on table public.ai_analysis_leases to service_role;

create or replace function public.ai_quota_take(
  p_bucket text,
  p_limit integer,
  p_expires timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    return false;
  end if;
  if p_bucket is null or length(p_bucket) < 8 or length(p_bucket) > 240 then
    return false;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 or p_expires is null then
    return false;
  end if;

  insert into public.ai_quota_counters as c (bucket, hits, expires_at)
  values (p_bucket, 1, p_expires)
  on conflict (bucket) do update
    set hits = case
          when c.expires_at <= now() then 1
          else c.hits + 1
        end,
        expires_at = case
          when c.expires_at <= now() then excluded.expires_at
          else c.expires_at
        end
    where c.expires_at <= now() or c.hits < p_limit
  returning hits into v_hits;

  return v_hits is not null;
exception
  when no_data_found then
    return false;
end;
$$;

create or replace function public.ai_quota_give_back(p_bucket text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    return;
  end if;
  update public.ai_quota_counters
     set hits = greatest(hits - 1, 0)
   where bucket = p_bucket;
end;
$$;

create or replace function public.consume_ai_quota(
  p_user_id uuid,
  p_ip_hash text,
  p_endpoint text,
  p_user_per_minute integer,
  p_user_per_day integer,
  p_ip_per_minute integer,
  p_ip_per_day integer,
  p_concurrency_limit integer,
  p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_minute timestamptz := date_trunc('minute', v_now);
  v_day timestamptz := date_trunc('day', v_now);
  b_user_minute text;
  b_user_day text;
  b_ip_minute text;
  b_ip_day text;
  v_inflight integer;
  v_lease uuid;
  taken text[] := array[]::text[];
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_user_id is null
     or p_endpoint not in ('coach', 'generate-practice', 'analyse-homework')
     or p_ip_hash is null
     or p_ip_hash !~ '^[a-f0-9]{32}$'
     or p_user_per_minute is null or p_user_per_minute < 1 or p_user_per_minute > 100000
     or p_user_per_day is null or p_user_per_day < 1 or p_user_per_day > 100000
     or p_ip_per_minute is null or p_ip_per_minute < 1 or p_ip_per_minute > 100000
     or p_ip_per_day is null or p_ip_per_day < 1 or p_ip_per_day > 100000
     or p_concurrency_limit is null or p_concurrency_limit < 0 or p_concurrency_limit > 20
     or p_lease_seconds is null or p_lease_seconds < 0 or p_lease_seconds > 600
     or (p_concurrency_limit > 0 and p_lease_seconds < 30)
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(p_endpoint));

  delete from public.ai_quota_counters where expires_at < v_now;
  delete from public.ai_analysis_leases where expires_at <= v_now;

  if p_concurrency_limit > 0 then
    select count(*)::integer into v_inflight
      from public.ai_analysis_leases
     where user_id = p_user_id
       and endpoint = p_endpoint;
    if v_inflight >= p_concurrency_limit then
      return jsonb_build_object('ok', false, 'reason', 'concurrency');
    end if;
  end if;

  b_user_minute := 'u:' || p_user_id::text || ':' || p_endpoint || ':m:' || to_char(v_minute, 'YYYYMMDDHH24MI');
  b_user_day := 'u:' || p_user_id::text || ':' || p_endpoint || ':d:' || to_char(v_day, 'YYYYMMDD');
  b_ip_minute := 'ip:' || p_ip_hash || ':' || p_endpoint || ':m:' || to_char(v_minute, 'YYYYMMDDHH24MI');
  b_ip_day := 'ip:' || p_ip_hash || ':' || p_endpoint || ':d:' || to_char(v_day, 'YYYYMMDD');

  if not public.ai_quota_take(b_user_minute, p_user_per_minute, v_minute + interval '2 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'user_minute');
  end if;
  taken := array_append(taken, b_user_minute);

  if not public.ai_quota_take(b_user_day, p_user_per_day, v_day + interval '2 days') then
    perform public.ai_quota_give_back(b) from unnest(taken) as u(b);
    return jsonb_build_object('ok', false, 'reason', 'user_day');
  end if;
  taken := array_append(taken, b_user_day);

  if not public.ai_quota_take(b_ip_minute, p_ip_per_minute, v_minute + interval '2 minutes') then
    perform public.ai_quota_give_back(b) from unnest(taken) as u(b);
    return jsonb_build_object('ok', false, 'reason', 'ip_minute');
  end if;
  taken := array_append(taken, b_ip_minute);

  if not public.ai_quota_take(b_ip_day, p_ip_per_day, v_day + interval '2 days') then
    perform public.ai_quota_give_back(b) from unnest(taken) as u(b);
    return jsonb_build_object('ok', false, 'reason', 'ip_day');
  end if;

  if p_concurrency_limit > 0 then
    insert into public.ai_analysis_leases (user_id, endpoint, expires_at)
    values (p_user_id, p_endpoint, v_now + make_interval(secs => p_lease_seconds))
    returning id into v_lease;
  end if;

  return jsonb_build_object('ok', true, 'lease_id', v_lease);
end;
$$;

create or replace function public.release_ai_concurrency(p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    return;
  end if;
  if p_lease_id is null then
    return;
  end if;
  delete from public.ai_analysis_leases where id = p_lease_id;
end;
$$;

revoke all on function public.ai_quota_take(text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_quota_give_back(text) from public, anon, authenticated;
revoke all on function public.consume_ai_quota(uuid, text, text, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.release_ai_concurrency(uuid) from public, anon, authenticated;

grant execute on function public.consume_ai_quota(uuid, text, text, integer, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.release_ai_concurrency(uuid) to service_role;
