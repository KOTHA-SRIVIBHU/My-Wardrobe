-- Run once in the Supabase SQL editor, AFTER the backend has started against your
-- Supabase database at least once (the backend creates the tables on startup).

-- Only the backend talks to these tables (it connects as the database owner and
-- scopes every query to the signed-in user). Enabling RLS with no policies makes
-- sure the public Supabase REST API can't read or write them with the anon key.
alter table public.garments        enable row level security;
alter table public.garment_events  enable row level security;
alter table public.pairs           enable row level security;
alter table public.pair_items      enable row level security;
alter table public.laundry_baskets enable row level security;
alter table public.basket_items    enable row level security;
alter table public.outfit_feedback enable row level security;
alter table public.user_settings   enable row level security;
alter table public.routines        enable row level security;
alter table public.events          enable row level security;
alter table public.weather_reports enable row level security;
alter table public.plan_entries    enable row level security;
alter table public.ai_usage        enable row level security;

-- Private bucket for garment photos. The backend serves short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('garment-images', 'garment-images', false)
on conflict (id) do nothing;
