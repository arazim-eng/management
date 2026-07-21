-- 21.7.26: handler emails from Moshe (jerusalem.muni.il). סנדרה — no email yet.
insert into handlers (id, name, email, send_weekly) values
  ('h-kobi',    'קובי שמואלי',  'shyakov@jerusalem.muni.il',    true),
  ('h-shlomi',  'שלומי שוקרון', 'ShShlomi@jerusalem.muni.il',   true),
  ('h-leah',    'לאה סנדרס',    'leah_sa@jerusalem.muni.il',    true),
  ('h-hadassa', 'הדסה',         'hadassa_ro@jerusalem.muni.il', true),
  ('h-shmuel',  'שמואל לשם',    'shmuel_les@jerusalem.muni.il', true),
  ('h-mohamad', 'מוחמד',        'mohamad_mu@jerusalem.muni.il', true),
  ('h-tehila',  'תהילה ארז',    'Tehila_er@jerusalem.muni.il',  true)
on conflict (name) do update set email = excluded.email, send_weekly = excluded.send_weekly, updated_at = now();
