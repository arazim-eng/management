-- 21.7.26: weekly handler emails — Sundays 06:00 UTC (= 09:00 Israel summer time)
-- Sends only to handlers that have an email filled + send_weekly=true; otherwise no-op.
select cron.unschedule('handler-weekly-sunday') where exists (select 1 from cron.job where jobname='handler-weekly-sunday');
select cron.schedule(
  'handler-weekly-sunday',
  '0 6 * * 0',
  $$
  select net.http_post(
    url := 'https://kwmldvcsucbuvsjsiuaq.supabase.co/functions/v1/handler-weekly',
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3bWxkdmNzdWNidXZzanNpdWFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1OTE3ODYsImV4cCI6MjA5NDE2Nzc4Nn0.5_gKgNR6PCz3iWV0aMSWWoIpCPagKBO4LM7KwQuIFr8"}'::jsonb
  ) as request_id;
  $$
);
