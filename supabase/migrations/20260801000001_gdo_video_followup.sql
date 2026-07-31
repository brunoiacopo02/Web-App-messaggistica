-- Follow-up del video per i lead dei GDO.
--
-- Il flusso postino consegna agenda e video e poi si ferma: questi lead sono esclusi da
-- sequenza, follow-up agenda, watchdog e promemoria pre-call. Queste colonne reggono i
-- due soli solleciti previsti (21:30 del giorno dell'agenda, 10:00 del giorno dopo) e il
-- promemoria di Noemi, che si dà una volta sola.

alter table public.conversations
  add column if not exists gdo_video_watched_at timestamptz,
  add column if not exists gdo_video_followups_sent smallint not null default 0,
  add column if not exists gdo_noemi_reminded_at timestamptz,
  add column if not exists gdo_appuntamento_at timestamptz;

comment on column public.conversations.gdo_video_watched_at is
  'Quando il lead ha confermato di aver visto il video. Il segnale esisteva già (videoWatched del modello) ma finiva solo in event_log, che non è interrogabile per decidere.';
comment on column public.conversations.gdo_video_followups_sent is
  'Quanti solleciti video sono partiti: 0, 1 o 2. Mai di più.';
comment on column public.conversations.gdo_noemi_reminded_at is
  'Quando il bot ha spiegato la chiamata di Noemi. Valorizzato = non si ripete.';
comment on column public.conversations.gdo_appuntamento_at is
  'Data della videocall. Il payload del CRM oggi NON la manda (verificato il 31/07 su lib/bot-contract.ts): la colonna nasce vuota e si valorizza appena il campo arriva, per non richiedere una seconda migration.';
