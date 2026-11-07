-- A/B del modello di Mario (decisione PO 07/11/2026): ogni conversazione ha un braccio
-- fisso, 'sonnet' (claude-sonnet-5-5) o 'opus' (claude-opus-5-5 + blocco di vendita).
-- Si assegna al primo turno di Mario (hash dell'id contro la percentuale in
-- app_settings.mario_opus_percentuale) e non cambia piu', neanche se la percentuale
-- cambia. NULL = mai assegnato (chat senza turni di Mario dopo il 07/11).
alter table public.conversations
  add column if not exists mario_braccio text
  check (mario_braccio is null or mario_braccio in ('sonnet', 'opus'));

comment on column public.conversations.mario_braccio is
  'Braccio A/B del modello di Mario: sonnet | opus. Scritto al primo turno, poi fisso (lib/mario-braccio.ts).';
