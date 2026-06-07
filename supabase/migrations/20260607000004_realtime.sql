-- Abilita Supabase Realtime per l'inbox live.
-- Senza l'aggiunta alla pubblicazione `supabase_realtime`, Postgres non emette
-- eventi e l'UI si aggiorna solo al refresh.
-- `replica identity full` serve a ricevere la riga completa anche sugli UPDATE
-- (es. aggiornamenti di stato Twilio: delivered/read).

alter table public.messages replica identity full;
alter table public.conversations replica identity full;

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;
