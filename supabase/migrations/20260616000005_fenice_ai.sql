-- Stato AI sulle conversazioni (Mario) + interruttore globale auto-risposta.

alter table conversations
  add column if not exists ai_owner  text,                -- null = umano | 'mario'
  add column if not exists ai_status text;                -- null | 'active' | 'handed_off' | 'booked'

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value)
  values ('fenice_ai_autoreply', 'false'::jsonb)
  on conflict (key) do nothing;
