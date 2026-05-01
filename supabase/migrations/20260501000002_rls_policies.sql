-- Abilita RLS su tutte le tabelle
alter table campaigns      enable row level security;
alter table leads          enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table event_log      enable row level security;

-- Policy: utenti authenticated possono fare tutto (single tenant V1)
-- Le route webhook usano service_role che bypassa RLS

create policy "auth_all_campaigns" on campaigns
  for all to authenticated using (true) with check (true);

create policy "auth_all_leads" on leads
  for all to authenticated using (true) with check (true);

create policy "auth_all_conversations" on conversations
  for all to authenticated using (true) with check (true);

create policy "auth_all_messages" on messages
  for all to authenticated using (true) with check (true);

create policy "auth_all_event_log" on event_log
  for all to authenticated using (true) with check (true);
