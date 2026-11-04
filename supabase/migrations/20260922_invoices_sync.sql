-- 22.9.26: סנכרון חד-כיווני ממערכת החשבוניות (arazim-invoices) לטבלת החשבונות.
-- מהיום מפיקים מסמכים רק שם (סאמיט ואיזי קאונט קפואים), ולכן הטבלה מתמלאת
-- ממשיכה כל 15 דקות במקום מ-webhook של איזי קאונט.
--
-- ⚠️ לא הורץ על הפרודקשן — להרצה ידנית אחרי שהפונקציה נפרסה והסודות הוגדרו.
--
-- ⚠️ לפני ההרצה: הסוד המשותף חייב להיות ב-Vault (פעם אחת, ידנית — הוא לא
-- נכתב לקובץ הזה ולא ל-git), ואותו ערך בדיוק כסוד INVOICES_SYNC_KEY של הפונקציה:
--   select vault.create_secret('<הסוד>', 'invoices_sync_key', 'x-sync-key של invoices-sync');

-- ---------- סימן המים ----------
-- שורה אחת לכל מקור סנכרון. last_created_at = ה-created_at הגבוה ביותר
-- שנסרק בהצלחה; הריצה הבאה מתחילה ממנו (פחות חלון חפיפה, ראו mapping.js).
create table if not exists public.sync_state (
  source          text primary key,
  last_run        timestamptz,
  last_created_at timestamptz,
  note            text
);

comment on table public.sync_state is
  'סימן מים לסנכרונים נכנסים. source=''arazim-invoices'' — מערכת החשבוניות.';

-- RLS: רק service_role (הפונקציה) כותב. לאפליקציה מותר לקרוא כדי להציג
-- "מתי סונכרן לאחרונה"; אין אף policy של כתיבה — בכוונה.
alter table public.sync_state enable row level security;

drop policy if exists sync_state_read on public.sync_state;
create policy sync_state_read on public.sync_state
  for select to authenticated using (true);

-- ---------- תזמון ----------
-- pg_cron קורא לפונקציה דרך net.http_post עם הכותרת x-sync-key. הסוד נשלף
-- מ-Vault בכל ריצה (11.10.26: הוחלף מפתח ה-anon — הוא ציבורי, יושב ב-index.html,
-- ולכן כל אחד יכול היה להפעיל פונקציה שכותבת עם service-role).
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'invoices_sync_key') then
    raise exception 'חסר הסוד invoices_sync_key ב-Vault — ראו ההערה בראש הקובץ';
  end if;
end $$;

select cron.unschedule('invoices-sync-15min') where exists (select 1 from cron.job where jobname = 'invoices-sync-15min');
select cron.schedule(
  'invoices-sync-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://kwmldvcsucbuvsjsiuaq.supabase.co/functions/v1/invoices-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-key', (select decrypted_secret from vault.decrypted_secrets where name = 'invoices_sync_key')
    ),
    timeout_milliseconds := 55000
  ) as request_id;
  $$
);
