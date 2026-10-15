-- ClosetIQ database setup.
--
-- Run this ONCE in your Supabase project: Dashboard -> SQL Editor -> New query ->
-- paste everything -> Run. It is safe to run again (e.g. after an app update asks you to).
--
-- How access works: the app connects with your project's URL and anon (publishable)
-- key, and sends your *vault passphrase* with every request. Every table only answers
-- requests that carry the right passphrase; the database stores only a bcrypt hash of it.
-- All changes go through one function (closetiq_apply) that applies them atomically.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------------
-- Vault metadata (never readable directly)
-- ---------------------------------------------------------------------------------
create table if not exists public.closetiq_meta (
  id int primary key default 1 check (id = 1),
  schema_version int not null,
  passphrase_hash text,
  created_at timestamptz not null default now()
);
alter table public.closetiq_meta enable row level security;
revoke all on public.closetiq_meta from anon, authenticated;
insert into public.closetiq_meta (id, schema_version) values (1, 1)
  on conflict (id) do update set schema_version = excluded.schema_version;

-- ---------------------------------------------------------------------------------
-- Data tables
-- ---------------------------------------------------------------------------------
create table if not exists public.garments (
  id text primary key,
  name text not null,
  category text not null,
  subcategory text,
  color text,
  pattern text,
  labels jsonb not null default '[]',
  occasions jsonb not null default '[]',
  formality int,
  seasons jsonb not null default '[]',
  weather jsonb not null default '[]',
  fabric text,
  comfort_notes text,
  max_wears_before_wash int,
  ironing_policy text not null default 'not_required',
  purchase_date date,
  purchase_price numeric(10, 2),
  notes text,
  photo_id text,
  state text not null default 'ready',
  iron_after_drying boolean not null default false,
  total_wears int not null default 0,
  wears_since_wash int not null default 0,
  last_worn_on date,
  last_washed_at timestamptz,
  archived boolean not null default false,
  archived_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev int not null default 0
);

create table if not exists public.photos (
  id text primary key,
  garment_id text not null references public.garments (id) on delete cascade,
  mime text not null,
  data text not null, -- base64, downscaled on the phone (~50-100 KB)
  created_at timestamptz not null default now()
);
create index if not exists photos_garment on public.photos (garment_id);

create table if not exists public.pairs (
  id text primary key,
  name text not null,
  description text,
  labels jsonb not null default '[]',
  occasion text,
  favorite boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev int not null default 0
);

create table if not exists public.pair_items (
  id text primary key,
  pair_id text not null references public.pairs (id) on delete cascade,
  garment_id text not null references public.garments (id) on delete cascade,
  position int not null default 0
);

create table if not exists public.laundry_baskets (
  id text primary key,
  name text not null,
  kind text not null default 'laundry', -- laundry | ironing
  description text,
  scheduled_for date,
  expected_completion_at timestamptz,
  status text not null default 'pending', -- pending | in_progress | completed
  notes text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  rev int not null default 0
);
-- Exactly one (permanent) ironing basket.
create unique index if not exists one_ironing_basket on public.laundry_baskets (kind) where kind = 'ironing';

create table if not exists public.basket_items (
  id text primary key,
  basket_id text not null references public.laundry_baskets (id) on delete cascade,
  garment_id text not null references public.garments (id) on delete cascade,
  added_at timestamptz not null default now(),
  previous_state text not null,
  active boolean not null default true,
  outcome text,
  resolved_at timestamptz
);
-- A garment is in at most one basket at a time.
create unique index if not exists one_active_basket_per_garment on public.basket_items (garment_id) where active;

create table if not exists public.garment_events (
  id text primary key,
  garment_id text not null references public.garments (id) on delete cascade,
  kind text not null,
  from_state text,
  to_state text,
  basket_id text references public.laundry_baskets (id) on delete set null,
  pair_id text references public.pairs (id) on delete set null,
  worn_on date,
  note text,
  at timestamptz not null default now()
);
create index if not exists garment_events_garment on public.garment_events (garment_id, at);
create index if not exists garment_events_worn on public.garment_events (worn_on) where kind = 'worn';

create table if not exists public.outfit_feedback (
  id text primary key,
  garment_ids jsonb not null,
  rating int not null,
  created_at timestamptz not null default now()
);

create table if not exists public.routines (
  id text primary key,
  name text not null,
  kind text not null default 'day',
  weekdays jsonb not null default '[]',
  start_date date,
  end_date date,
  occasion text,
  formality int,
  requirements jsonb not null default '[]',
  mandatory boolean not null default true,
  active boolean not null default true,
  source_text text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev int not null default 0
);

create table if not exists public.events (
  id text primary key,
  title text not null,
  kind text not null default 'custom',
  date date not null,
  start_time text,
  end_time text,
  occasion text,
  formality int,
  labels jsonb not null default '[]',
  notes text,
  skip_day_routines boolean not null default false,
  garment_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev int not null default 0
);

create table if not exists public.weather_reports (
  id text primary key,
  date date not null unique,
  tags jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists public.plan_entries (
  id text primary key,
  date date not null,
  slot_key text not null,
  title text not null,
  garment_ids jsonb not null default '[]',
  locked boolean not null default false,
  status text not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev int not null default 0,
  unique (date, slot_key)
);

create table if not exists public.settings (
  id text primary key default 'me' check (id = 'me'),
  location_name text,
  latitude double precision,
  longitude double precision,
  laundry_weekdays jsonb not null default '[]',
  drying_days int not null default 1,
  notification_prefs jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  rev int not null default 0
);

-- ---------------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------------

-- True when the request carries the right vault passphrase (header x-closetiq-passphrase).
create or replace function public.closetiq_authorized() returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  stored text;
  supplied text;
begin
  select passphrase_hash into stored from public.closetiq_meta where id = 1;
  if stored is null then
    return false;
  end if;
  supplied := nullif(current_setting('request.headers', true), '')::json ->> 'x-closetiq-passphrase';
  if supplied is null or supplied = '' then
    return false;
  end if;
  return extensions.crypt(supplied, stored) = stored;
end $$;

-- Reads: allowed only with the passphrase. Writes: only through closetiq_apply().
do $$
declare
  t text;
begin
  foreach t in array array['garments', 'photos', 'pairs', 'pair_items', 'laundry_baskets', 'basket_items',
    'garment_events', 'outfit_feedback', 'routines', 'events', 'weather_reports', 'plan_entries', 'settings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists closetiq_read on public.%I', t);
    execute format('create policy closetiq_read on public.%I for select to anon, authenticated using ((select public.closetiq_authorized()))', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    -- Explicit, so it works on projects whose Data API doesn't grant table access by default.
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;

-- Setup state, readable without the passphrase (it reveals nothing else).
create or replace function public.closetiq_status() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'installed', true,
    'schema_version', schema_version,
    'has_passphrase', passphrase_hash is not null,
    'authorized', public.closetiq_authorized()
  ) from public.closetiq_meta where id = 1;
$$;

-- First time: sets the passphrase. Afterwards: changing it requires the current one.
create or replace function public.closetiq_set_passphrase(new_passphrase text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  stored text;
begin
  if length(coalesce(new_passphrase, '')) < 8 then
    raise exception 'The passphrase must be at least 8 characters.' using errcode = '22023';
  end if;
  select passphrase_hash into stored from public.closetiq_meta where id = 1 for update;
  if stored is not null and not public.closetiq_authorized() then
    raise exception 'The current passphrase is wrong.' using errcode = '28000';
  end if;
  update public.closetiq_meta
    set passphrase_hash = extensions.crypt(new_passphrase, extensions.gen_salt('bf', 10))
    where id = 1;
end $$;

-- Applies a list of changes atomically: all succeed or none do.
--   {"op":"insert","table":t,"row":{...}}
--   {"op":"update","table":t,"id":id,"set":{...},"rev":n}   (rev: optimistic concurrency, optional)
--   {"op":"delete","table":t,"id":id}
-- An update whose row changed meanwhile (another device) fails with a "conflict" error.
create or replace function public.closetiq_apply(ops jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare
  op jsonb;
  t text;
  cols text;
  has_rev boolean;
  n int;
  total int := 0;
  allowed constant text[] := array['garments', 'photos', 'pairs', 'pair_items', 'laundry_baskets', 'basket_items',
    'garment_events', 'outfit_feedback', 'routines', 'events', 'weather_reports', 'plan_entries', 'settings'];
begin
  if not public.closetiq_authorized() then
    raise exception 'Wrong or missing vault passphrase.' using errcode = '28000';
  end if;
  if jsonb_typeof(ops) <> 'array' then
    raise exception 'ops must be an array' using errcode = '22023';
  end if;

  for op in select value from jsonb_array_elements(ops) loop
    t := op ->> 'table';
    if t is null or not (t = any (allowed)) then
      raise exception 'Unknown table: %', t using errcode = '22023';
    end if;

    if op ->> 'op' = 'insert' then
      select string_agg(format('%I', c.column_name), ', ') into cols
        from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = t
          and (op -> 'row') ? c.column_name and c.column_name <> 'rev';
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', t, cols, cols, t)
        using op -> 'row';

    elsif op ->> 'op' = 'update' then
      select exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = t and c.column_name = 'rev'
      ) into has_rev;
      select string_agg(format('%I', c.column_name), ', ') into cols
        from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = t
          and (op -> 'set') ? c.column_name and c.column_name not in ('id', 'rev');
      if cols is null then
        continue;
      end if;
      if has_rev then
        execute format(
          'update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)), rev = rev + 1
             where id = $2 and ($3::int is null or rev = $3::int)', t, cols, cols, t)
          using op -> 'set', op ->> 'id', (op ->> 'rev')::int;
      else
        execute format(
          'update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where id = $2',
          t, cols, cols, t)
          using op -> 'set', op ->> 'id';
      end if;
      get diagnostics n = row_count;
      if n = 0 then
        raise exception 'conflict: % % was changed or removed on another device', t, op ->> 'id' using errcode = '40001';
      end if;

    elsif op ->> 'op' = 'delete' then
      execute format('delete from public.%I where id = $1', t) using op ->> 'id';

    else
      raise exception 'Unknown op: %', op ->> 'op' using errcode = '22023';
    end if;
    total := total + 1;
  end loop;
  return json_build_object('applied', total);
end $$;

-- Deletes everything (used by "Delete all my data" and before restoring a backup).
create or replace function public.closetiq_wipe() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.closetiq_authorized() then
    raise exception 'Wrong or missing vault passphrase.' using errcode = '28000';
  end if;
  delete from public.plan_entries;
  delete from public.events;
  delete from public.routines;
  delete from public.outfit_feedback;
  delete from public.weather_reports;
  delete from public.garment_events;
  delete from public.basket_items;
  delete from public.laundry_baskets;
  delete from public.pair_items;
  delete from public.pairs;
  delete from public.photos;
  delete from public.garments;
  delete from public.settings;
end $$;

revoke all on function public.closetiq_apply(jsonb) from public;
revoke all on function public.closetiq_wipe() from public;
revoke all on function public.closetiq_set_passphrase(text) from public;
grant execute on function public.closetiq_authorized() to anon, authenticated;
grant execute on function public.closetiq_status() to anon, authenticated;
grant execute on function public.closetiq_set_passphrase(text) to anon, authenticated;
grant execute on function public.closetiq_apply(jsonb) to anon, authenticated;
grant execute on function public.closetiq_wipe() to anon, authenticated;

-- Make the new functions visible to the API immediately.
notify pgrst, 'reload schema';
