-- 21.7.26: handler (גורם מטפל) contact emails for the weekly "missing work orders" email
create table if not exists handlers (
  id text primary key,
  name text not null unique,
  email text,
  send_weekly boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table handlers enable row level security;
drop policy if exists "team all handlers" on handlers;
create policy "team all handlers" on handlers
  for all using (public.is_team_member()) with check (public.is_team_member());
