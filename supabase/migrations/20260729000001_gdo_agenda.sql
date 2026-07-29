-- Invio agenda per conto dei GDO (POST /api/send-agenda).
--
-- Il lead resta di proprietà del commerciale (GDO) che l'ha al telefono: il bot fa da
-- postino. `gdo_agenda_at` è il marcatore della modalità postino — tiene questi lead
-- fuori dalla sequenza di riaggancio, dal follow-up agenda e dalla classificazione
-- automatica a 14 giorni, e fa mandare al CRM solo NOTE.

alter table public.conversations
  add column if not exists gdo_agenda_at timestamptz,
  add column if not exists gdo_agenda_esito text,
  add column if not exists gdo_video_url text,
  add column if not exists gdo_video_sent_at timestamptz;

comment on column public.conversations.gdo_agenda_at is
  'Ultimo invio agenda per conto di un GDO. Valorizzato = conversazione in modalità postino.';
comment on column public.conversations.gdo_agenda_esito is
  'Esito riportato al GDO: consegnato | inviato | fallito. Serve alla deduplica a 15 minuti.';
comment on column public.conversations.gdo_video_url is
  'Video da mandare alla prima risposta del lead, scelto dalla variante ricevuta dal CRM.';
comment on column public.conversations.gdo_video_sent_at is
  'Quando il video è partito. Nullo = il prossimo inbound del lead è il turno del video.';

-- I cron escludono le conversazioni postino (`gdo_agenda_at is null`): indice parziale
-- sulle sole righe marcate, che sono la minoranza.
create index if not exists conversations_gdo_agenda_at_idx
  on public.conversations (gdo_agenda_at)
  where gdo_agenda_at is not null;

-- La deduplica cerca l'ultimo invio per lead CRM.
create index if not exists conversations_crm_lead_gdo_idx
  on public.conversations (crm_lead_id, gdo_agenda_at desc)
  where gdo_agenda_at is not null;
