-- 21.7.26: Moshe — weekly handler emails at Sunday 08:00 Israel (05:00 UTC in summer)
select cron.unschedule('handler-weekly-sunday');
select cron.schedule(
  'handler-weekly-sunday',
  '0 5 * * 0',
  $$
  select net.http_post(
    url := 'https://kwmldvcsucbuvsjsiuaq.supabase.co/functions/v1/handler-weekly',
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3bWxkdmNzdWNidXZzanNpdWFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1OTE3ODYsImV4cCI6MjA5NDE2Nzc4Nn0.5_gKgNR6PCz3iWV0aMSWWoIpCPagKBO4LM7KwQuIFr8"}'::jsonb
  ) as request_id;
  $$
);
