-- שיחות המזכירה בוואטסאפ (ארזים ניקיון). service role בלבד — RLS פעיל בלי policies.
create table if not exists cleaning_conversations (
  chat_id text primary key,
  phone text,
  kind text,                      -- worker / customer / unknown
  locale text,                    -- he / ar / ru / am / en / other
  status text not null default 'OPEN',  -- OPEN / COMPLETE / HANDOFF / HUMAN
  ref_code text,
  fields jsonb not null default '{}'::jsonb,
  messages jsonb not null default '[]'::jsonb,
  lead_id uuid,
  replies_today int not null default 0,
  replies_day date,
  human_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cleaning_conversations enable row level security;
