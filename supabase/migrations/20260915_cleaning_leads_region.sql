-- אזור לכל מועמד + רשימת מועמדים לעדכון הדו-יומי (משה 15.9: "מאיזה אזורים", "לפי סוגי משרות")
alter table cleaning_worker_leads add column if not exists region text;

create or replace function cleaning_bot_lead_insert(p_secret text, p_table text, p_row jsonb) returns uuid language plpgsql security definer as $$
declare new_id uuid;
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  if p_table = 'cleaning_worker_leads' then
    insert into cleaning_worker_leads (id, created_at, updated_at, locale, name, phone, city, region, shifts, days, experience, transport, languages, work_permit, consent, ref_code, first_touch, last_touch, status, notes, internal_notes, age, availability_note, full_time, previous_work, benefits, limitations)
    select gen_random_uuid(), now(), now(), coalesce(r.locale,'he'), coalesce(r.name,'?'), coalesce(r.phone,'?'), coalesce(r.city,'?'), r.region, coalesce(r.shifts,'{}'), coalesce(r.days,'{}'), r.experience, r.transport, coalesce(r.languages,'{}'), r.work_permit, coalesce(r.consent,true), r.ref_code, r.first_touch, r.last_touch, coalesce(r.status,'NEW'), r.notes, r.internal_notes, r.age, r.availability_note, r.full_time, r.previous_work, r.benefits, r.limitations
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
    update cleaning_worker_leads t set (locale,name,city,region,shifts,days,experience,transport,languages,work_permit,ref_code,status,notes,internal_notes,age,availability_note,full_time,previous_work,benefits,limitations,updated_at)
      = (select locale,name,city,region,shifts,days,experience,transport,languages,work_permit,ref_code,status,notes,internal_notes,age,availability_note,full_time,previous_work,benefits,limitations,now()
         from jsonb_populate_record(t, patch)) where t.id = p_id;
  elsif p_table = 'cleaning_customer_leads' then
    update cleaning_customer_leads t set (name,city,service_type,notes,ref_code,status,internal_notes,updated_at)
      = (select name,city,service_type,notes,ref_code,status,internal_notes,now() from jsonb_populate_record(t, patch)) where t.id = p_id;
  else raise exception 'bad table'; end if;
end $$;

create or replace function cleaning_bot_leads_all(p_secret text) returns jsonb language plpgsql security definer as $$
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'created_at',created_at,'name',name,'phone',phone,'city',city,'region',region,'shifts',shifts,'full_time',full_time,'status',status,'locale',locale) order by created_at)
    from cleaning_worker_leads where coalesce(status,'') <> 'MOVED'), '[]'::jsonb);
end $$;
revoke all on function cleaning_bot_leads_all(text) from public;
grant execute on function cleaning_bot_leads_all(text), cleaning_bot_lead_insert(text,text,jsonb), cleaning_bot_lead_update(text,text,uuid,jsonb) to anon;

update cleaning_worker_leads set region = case city
  when 'אשקלון' then 'דרום' when 'אשדוד' then 'דרום' when 'תל אביב' then 'מרכז' when 'פתח תקווה' then 'מרכז' when 'חיפה' then 'חיפה והקריות' end
where region is null;
