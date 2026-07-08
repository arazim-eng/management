-- Project folder files + auto numbering + חשבון עסקה muni-submission tracking
alter table public.invoices add column if not exists submitted_to_muni boolean default false;
alter table public.invoices add column if not exists muni_submit_date  date;
alter table public.projects add column if not exists files          jsonb default '[]'::jsonb;
alter table public.projects add column if not exists project_number  text;
