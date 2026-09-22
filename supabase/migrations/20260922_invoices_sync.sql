-- 22.9.26: סנכרון חד-כיווני ממערכת החשבוניות (arazim-invoices) לטבלת החשבונות.
-- מהיום מפיקים מסמכים רק שם (סאמיט ואיזי קאונט קפואים), ולכן הטבלה מתמלאת
-- ממשיכה כל 15 דקות במקום מ-webhook של איזי קאונט.
--
-- ⚠️ לא הורץ על הפרודקשן — להרצה ידנית אחרי שהפונקציה נפרסה והסודות הוגדרו.

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
-- אותו דפוס כמו 20260721_handler_weekly_cron.sql: pg_cron קורא לפונקציה
-- דרך net.http_post עם מפתח ה-anon של הפרויקט (הפונקציה רצה עם verify_jwt,
-- והמפתח הזה הוא ציבורי ממילא — הוא יושב גם ב-index.html וב-workflows).
select cron.unschedule('invoices-sync-15min') where exists (select 1 from cron.job where jobname = 'invoices-sync-15min');
select cron.schedule(
  'invoices-sync-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://kwmldvcsucbuvsjsiuaq.supabase.co/functions/v1/invoices-sync',
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3bWxkdmNzdWNidXZzanNpdWFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1OTE3ODYsImV4cCI6MjA5NDE2Nzc4Nn0.5_gKgNR6PCz3iWV0aMSWWoIpCPagKBO4LM7KwQuIFr8", "Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 55000
  ) as request_id;
  $$
);
