-- 22.9.26: חשבונות ספקים בתוך הפרויקט (בקשת משה).
-- "יש פרויקט שאני משלם ממנו לספקים — אני רוצה להכניס שם חשבונות, אישורי תשלום וכו'."
--
-- כלל המע"מ זהה לפרויקטים: amount נשמר **ללא מע"מ**, והטופס מציג גם כולל.
-- (זה בדיוק ההפרש שגרם ל"שארית" הנצחית בין שכ"ט הפיקוח לחשבוניות — לא חוזרים עליו.)
create table if not exists supplier_invoices (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  supplier text not null,
  doc_type text not null default 'חשבון',          -- חשבון · חשבונית מס · אישור תשלום
  doc_number text,
  amount numeric,                                   -- ללא מע"מ
  status text not null default 'received',          -- received · approved · paid · rejected
  date_received date,
  date_approved date,
  date_paid date,
  approved_by text,
  notes text,
  file_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists supplier_invoices_project_idx on supplier_invoices(project_id);
create index if not exists supplier_invoices_status_idx on supplier_invoices(status);

alter table supplier_invoices enable row level security;
drop policy if exists "team all supplier_invoices" on supplier_invoices;
create policy "team all supplier_invoices" on supplier_invoices
  for all using (public.is_team_member()) with check (public.is_team_member());
