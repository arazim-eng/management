-- בדיקה פעמיים ביום: תור מעקבים (הודעות חזרה לאנשים) + רישום תקלות. קריאה/כתיבה לבוט דרך RPC עם סוד.
create table if not exists cleaning_followups (
  id uuid primary key default gen_random_uuid(), chat_id text not null, message text not null, reason text,
  send_after timestamptz not null default now(), sent_at timestamptz, result text, created_at timestamptz not null default now());
alter table cleaning_followups enable row level security;
drop policy if exists "team read followups" on cleaning_followups;
create policy "team read followups" on cleaning_followups for select using (is_team_member());

create table if not exists cleaning_bot_issues (
  id uuid primary key default gen_random_uuid(), chat_id text, kind text not null, detail text,
  created_at timestamptz not null default now(), resolved_at timestamptz);
alter table cleaning_bot_issues enable row level security;
drop policy if exists "team read issues" on cleaning_bot_issues;
create policy "team read issues" on cleaning_bot_issues for select using (is_team_member());

create or replace function cleaning_bot_conv_recent(p_secret text, p_since timestamptz) returns jsonb language plpgsql security definer as $$
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.updated_at) from cleaning_conversations c where c.updated_at >= p_since), '[]'::jsonb);
end $$;

create or replace function cleaning_bot_followup_add(p_secret text, p_chat text, p_message text, p_reason text, p_send_after timestamptz) returns uuid language plpgsql security definer as $$
declare new_id uuid;
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  -- לא יותר ממעקב אחד פתוח לכל שיחה
  if exists (select 1 from cleaning_followups where chat_id = p_chat and sent_at is null) then return null; end if;
  insert into cleaning_followups (chat_id, message, reason, send_after) values (p_chat, p_message, p_reason, coalesce(p_send_after, now())) returning id into new_id;
  return new_id;
end $$;

create or replace function cleaning_bot_followups_due(p_secret text) returns jsonb language plpgsql security definer as $$
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.send_after) from cleaning_followups f where f.sent_at is null and f.send_after <= now()), '[]'::jsonb);
end $$;

create or replace function cleaning_bot_followup_done(p_secret text, p_id uuid, p_result text) returns void language plpgsql security definer as $$
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  update cleaning_followups set sent_at = now(), result = p_result where id = p_id;
end $$;

create or replace function cleaning_bot_issue_add(p_secret text, p_chat text, p_kind text, p_detail text) returns uuid language plpgsql security definer as $$
declare new_id uuid;
begin
  if not cleaning_bot_auth(p_secret) then raise exception 'unauthorized'; end if;
  insert into cleaning_bot_issues (chat_id, kind, detail) values (p_chat, p_kind, p_detail) returning id into new_id;
  return new_id;
end $$;

revoke all on function cleaning_bot_conv_recent(text,timestamptz), cleaning_bot_followup_add(text,text,text,text,timestamptz), cleaning_bot_followups_due(text), cleaning_bot_followup_done(text,uuid,text), cleaning_bot_issue_add(text,text,text,text) from public;
grant execute on function cleaning_bot_conv_recent(text,timestamptz), cleaning_bot_followup_add(text,text,text,text,timestamptz), cleaning_bot_followups_due(text), cleaning_bot_followup_done(text,uuid,text), cleaning_bot_issue_add(text,text,text,text) to anon;
