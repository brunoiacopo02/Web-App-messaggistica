-- Lancio "Web Developer AI" (webinar del 5/10/2026), blocco B1 lato bot.
-- Spec: docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §3.2
--
-- Le conversazioni del lancio restano `ai_owner='mario'` (così i pannelli le vedono da
-- sole) ma vivono in un flusso a fasi tutto loro: `lancio_slug` dice che la chat e' del
-- lancio, `lancio_fase` a che punto e'. I cron di Mario (sequenza, nudge, promemoria,
-- solleciti) le escludono finche' la fase non e' terminale (`chiuso`/`restituito`).

alter table public.conversations
  add column if not exists lancio_slug text,
  add column if not exists lancio_fase text,
  add column if not exists lancio_ingresso text,
  add column if not exists lancio_link_inviato_at timestamptz,
  add column if not exists lancio_followup_inviato_at timestamptz,
  add column if not exists lancio_info jsonb,
  add column if not exists lancio_benvenuto_at timestamptz;

comment on column public.conversations.lancio_slug is
  'Identificativo del lancio (es. webdev-2026-10). Valorizzato = la chat e'' del lancio, non del fissaggio di Mario.';
comment on column public.conversations.lancio_fase is
  'attesa | posto_bloccato | link_inviato | post_pitch | scelta_fatta | followup_inviato | restituito | chiuso';
comment on column public.conversations.lancio_ingresso is
  'lista (dalla lista AC 132) | pulsante_webinar (ha scritto lui dal pulsante della live)';
comment on column public.conversations.lancio_link_inviato_at is
  'Quando e'' partito il template col link Zoom (B4). Idempotenza del blast.';
comment on column public.conversations.lancio_followup_inviato_at is
  'Quando e'' partito il follow-up del 6/10 (B5). Base delle 48h di restituzione.';
comment on column public.conversations.lancio_benvenuto_at is
  'Quando e'' partito il benvenuto del lancio. E'' il lucchetto dell''invio: l''intake e il cron lancio-aperture lo scrivono PRIMA/DOPO l''invio e nessuno dei due tocca una riga gia'' timbrata. Rimesso a null se l''invio fallisce.';
comment on column public.conversations.lancio_info is
  'Risposte di riscaldamento raccolte la sera del 5 (B4), passate al venditore.';

-- I cron del lancio e i filtri dei pannelli cercano per slug e fase: parziale, resta
-- piccolo (le chat del lancio sono qualche migliaio su decine di migliaia).
create index if not exists conversations_lancio_idx
  on public.conversations (lancio_slug, lancio_fase)
  where lancio_slug is not null;

-- Chiavi impostazioni (§3.2). Valori iniziali, mai sovrascritti se gia'' presenti:
-- Bruno le cambia da /fenice (B5) senza deploy. `lancio_attivo` nasce spento.
insert into public.app_settings (key, value) values
  ('lancio_attivo', 'false'::jsonb),
  ('lancio_zoom_link', '"https://us06web.zoom.us/j/89845223337"'::jsonb),
  ('lancio_video_live_link', '""'::jsonb),
  ('offerta_del_mese_link', '""'::jsonb),
  ('lancio_evento_at', '"2026-10-05T21:00:00+02:00"'::jsonb)
on conflict (key) do nothing;
