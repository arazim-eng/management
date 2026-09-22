-- ארזים ניקיון — לידים של עובדים ולקוחות (שלב 1, בדיקת היצע כוח אדם). 14.9.2026
-- האתר (cleaning.arazim-eng.co.il) כותב עם anon key בלבד (insert-only); הצוות קורא/מעדכן דרך is_team_member().
create extension if not exists pgcrypto;

create table if not exists cleaning_worker_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  locale text not null default 'he',
  name text not null,
  phone text not null,
  city text not null,
  shifts text[] not null default '{}',      -- morning / afternoon / full_day
  days text[] not null default '{}',        -- 0..5 = ראשון..שישי
  experience text,                          -- none / lt1 / 1to3 / gt3
  transport text,                           -- own_car / public / needs_ride
  languages text[] not null default '{}',
  work_permit text,                         -- yes / no / discuss
  consent boolean not null default false,
  ref_code text,
  first_touch jsonb,
  last_touch jsonb,
  status text not null default 'NEW',       -- NEW / CONTACTED / QUALIFIED / NOT_RELEVANT / HIRED
  notes text,
  updated_at timestamptz not null default now()
);
create index if not exists cleaning_worker_leads_created_idx on cleaning_worker_leads (created_at desc);
create index if not exists cleaning_worker_leads_status_idx on cleaning_worker_leads (status);
create index if not exists cleaning_worker_leads_city_idx on cleaning_worker_leads (city);

create table if not exists cleaning_customer_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  city text not null,
  service_type text,                        -- recurring / one_time
  notes text,
  consent boolean not null default false,
  ref_code text,
  first_touch jsonb,
  last_touch jsonb,
  status text not null default 'NEW',       -- NEW / CONTACTED / QUOTED / WON / LOST
  updated_at timestamptz not null default now()
);
create index if not exists cleaning_customer_leads_created_idx on cleaning_customer_leads (created_at desc);

alter table cleaning_worker_leads enable row level security;
alter table cleaning_customer_leads enable row level security;

-- האתר: הכנסה בלבד, בלי קריאה (anon)
drop policy if exists cwl_anon_insert on cleaning_worker_leads;
create policy cwl_anon_insert on cleaning_worker_leads for insert to anon with check (consent = true);
drop policy if exists ccl_anon_insert on cleaning_customer_leads;
create policy ccl_anon_insert on cleaning_customer_leads for insert to anon with check (consent = true);

-- הצוות (משה + משרד): קריאה ועדכון
drop policy if exists cwl_team_all on cleaning_worker_leads;
create policy cwl_team_all on cleaning_worker_leads for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
drop policy if exists ccl_team_all on cleaning_customer_leads;
create policy ccl_team_all on cleaning_customer_leads for all to authenticated using (public.is_team_member()) with check (public.is_team_member());

grant insert on cleaning_worker_leads, cleaning_customer_leads to anon;
grant select, insert, update on cleaning_worker_leads, cleaning_customer_leads to authenticated;

-- הערות פנימיות של הצוות (נפרד מ-notes של הלקוח בטופס)
alter table cleaning_worker_leads add column if not exists internal_notes text;
alter table cleaning_customer_leads add column if not exists internal_notes text;
