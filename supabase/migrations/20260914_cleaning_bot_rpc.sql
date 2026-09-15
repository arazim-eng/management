-- גישת הבוט ל-DB בלי service role: פונקציות SECURITY DEFINER שמאמתות סוד משותף (hash) ונקראות עם anon key.
create table if not exists cleaning_bot_config (id int primary key default 1, secret_sha256 text not null, updated_at timestamptz default now());
alter table cleaning_bot_config enable row level security;

create or replace function cleaning_bot_auth(p_secret text) returns boolean language sql security definer stable as $$
  select exists (select 1 from cleaning_bot_config where secret_sha256 = encode(digest(p_secret, 'sha256'), 'hex'));
$$;

create or replace function cleaning_bot_conv_get(p_secret text, p_chat text) returns jsonb language plpgsql security definer as $$
declare r jsonb;
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  select to_jsonb(c) into r from cleaning_conversations c where chat_id = p_chat;
  return r;
end $$;

create or replace function cleaning_bot_conv_save(p_secret text, p_conv jsonb) returns void language plpgsql security definer as $$
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  insert into cleaning_conversations (chat_id, phone, kind, locale, status, ref_code, fields, messages, lead_id, replies_today, replies_day, human_until, updated_at)
  values (p_conv->>'chat_id', p_conv->>'phone', p_conv->>'kind', p_conv->>'locale', coalesce(p_conv->>'status','OPEN'), p_conv->>'ref_code',
          coalesce(p_conv->'fields','{}'::jsonb), coalesce(p_conv->'messages','[]'::jsonb), nullif(p_conv->>'lead_id','')::uuid,
          coalesce((p_conv->>'replies_today')::int,0), nullif(p_conv->>'replies_day','')::date, nullif(p_conv->>'human_until','')::timestamptz, now())
  on conflict (chat_id) do update set phone=excluded.phone, kind=excluded.kind, locale=excluded.locale, status=excluded.status, ref_code=excluded.ref_code,
    fields=excluded.fields, messages=excluded.messages, lead_id=excluded.lead_id, replies_today=excluded.replies_today, replies_day=excluded.replies_day, human_until=excluded.human_until, updated_at=now();
end $$;

create or replace function cleaning_bot_lead_insert(p_secret text, p_table text, p_row jsonb) returns uuid language plpgsql security definer as $$
declare new_id uuid;
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  if p_table = 'cleaning_worker_leads' then
    insert into cleaning_worker_leads (id, created_at, updated_at, locale, name, phone, city, shifts, days, experience, transport, languages, work_permit, consent, ref_code, first_touch, last_touch, status, notes, internal_notes, age, availability_note, full_time, previous_work, benefits, limitations)
    select gen_random_uuid(), now(), now(), coalesce(r.locale,'he'), coalesce(r.name,'?'), coalesce(r.phone,'?'), coalesce(r.city,'?'), coalesce(r.shifts,'{}'), coalesce(r.days,'{}'), r.experience, r.transport, coalesce(r.languages,'{}'), r.work_permit, coalesce(r.consent,true), r.ref_code, r.first_touch, r.last_touch, coalesce(r.status,'NEW'), r.notes, r.internal_notes, r.age, r.availability_note, r.full_time, r.previous_work, r.benefits, r.limitations
    from jsonb_populate_record(null::cleaning_worker_leads, p_row) r returning id into new_id;
  elsif p_table = 'cleaning_customer_leads' then
    insert into cleaning_customer_leads (id, created_at, updated_at, name, phone, city, service_type, notes, consent, ref_code, first_touch, last_touch, status, internal_notes)
    select gen_random_uuid(), now(), now(), coalesce(r.name,'?'), coalesce(r.phone,'?'), coalesce(r.city,'?'), r.service_type, r.notes, coalesce(r.consent,true), r.ref_code, r.first_touch, r.last_touch, coalesce(r.status,'NEW'), r.internal_notes
    from jsonb_populate_record(null::cleaning_customer_leads, p_row) r returning id into new_id;
  else raise exception 'bad table'; end if;
  return new_id;
end $$;

create or replace function cleaning_bot_lead_update(p_secret text, p_table text, p_id uuid, p_patch jsonb) returns void language plpgsql security definer as $$
declare patch jsonb := p_patch - 'id' - 'created_at' - 'phone' - 'updated_at';
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  if p_table = 'cleaning_worker_leads' then
    update cleaning_worker_leads t set (locale,name,city,shifts,days,experience,transport,languages,work_permit,ref_code,status,notes,internal_notes,age,availability_note,full_time,previous_work,benefits,limitations,updated_at)
      = (select locale,name,city,shifts,days,experience,transport,languages,work_permit,ref_code,status,notes,internal_notes,age,availability_note,full_time,previous_work,benefits,limitations,now()
         from jsonb_populate_record(t, patch)) where t.id = p_id;
  elsif p_table = 'cleaning_customer_leads' then
    update cleaning_customer_leads t set (name,city,service_type,notes,ref_code,status,internal_notes,updated_at)
      = (select name,city,service_type,notes,ref_code,status,internal_notes,now() from jsonb_populate_record(t, patch)) where t.id = p_id;
  else raise exception 'bad table'; end if;
end $$;

revoke all on function cleaning_bot_auth(text) from public;
grant execute on function cleaning_bot_conv_get(text,text), cleaning_bot_conv_save(text,jsonb), cleaning_bot_lead_insert(text,text,jsonb), cleaning_bot_lead_update(text,text,uuid,jsonb) to anon;
