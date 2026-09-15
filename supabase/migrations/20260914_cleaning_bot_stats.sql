-- סטטיסטיקה יומית למשה (דוח טלגרם 08:00 מהבוט). קריאה בלבד, מאומת בסוד משותף.
create or replace function cleaning_bot_stats(p_secret text) returns jsonb language plpgsql security definer as $$
declare r jsonb; d0 timestamptz := (now() at time zone 'Asia/Jerusalem')::date::timestamp at time zone 'Asia/Jerusalem';
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  select jsonb_build_object(
    'workers_total', (select count(*) from cleaning_worker_leads),
    'workers_24h', (select count(*) from cleaning_worker_leads where created_at >= now() - interval '24 hours'),
    'workers_by_locale', (select coalesce(jsonb_object_agg(locale, n), '{}'::jsonb) from (select coalesce(locale,'?') locale, count(*) n from cleaning_worker_leads group by 1) t),
    'workers_by_city', (select coalesce(jsonb_object_agg(city, n), '{}'::jsonb) from (select coalesce(city,'?') city, count(*) n from cleaning_worker_leads group by 1 order by n desc limit 8) t),
    'customers_total', (select count(*) from cleaning_customer_leads),
    'customers_24h', (select count(*) from cleaning_customer_leads where created_at >= now() - interval '24 hours'),
    'convs_total', (select count(*) from cleaning_conversations),
    'convs_24h', (select count(*) from cleaning_conversations where updated_at >= now() - interval '24 hours'),
    'convs_open', (select count(*) from cleaning_conversations where kind='worker' and lead_id is null),
    'convs_human', (select count(*) from cleaning_conversations where human_until is not null and human_until > now()),
    'convs_by_ref', (select coalesce(jsonb_object_agg(ref_code, n), '{}'::jsonb) from (select coalesce(ref_code,'?') ref_code, count(*) n from cleaning_conversations group by 1 order by n desc limit 10) t)
  ) into r;
  return r;
end $$;
revoke all on function cleaning_bot_stats(text) from public;
grant execute on function cleaning_bot_stats(text) to anon, authenticated;
