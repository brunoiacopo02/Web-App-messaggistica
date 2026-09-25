-- Lancio "Web Developer AI": il messaggio "la live sta iniziando" della sera del 5/10
-- (decisione PO 5 del 25/09/2026), cron `lancio-inizio`.
--
-- Il timbro e' una COLONNA e non una chiave di `lancio_info` per la stessa ragione degli
-- altri due timbri del lancio: il motore degli invii (`lib/lancio-blast-motore.ts`) lo
-- usa come lucchetto con un compare-and-set (`update ... where colonna is null`) PRIMA
-- di chiamare Twilio. Su `lancio_info` servirebbe un leggi-fondi-riscrivi dell'intero
-- JSON, e mentre il cron manda il turno puo' scriverci il congedo o le risposte di
-- riscaldamento: la riscrittura le cancellerebbe.
--
-- Solo una colonna nullable: nessun indice (il cron filtra gia' su lancio_slug/lancio_fase,
-- `conversations_lancio_idx`), nessun default, nessun backfill.

alter table public.conversations
  add column if not exists lancio_inizio_inviato_at timestamptz;

comment on column public.conversations.lancio_inizio_inviato_at is
  'Quando e'' partito il template "la live sta iniziando" (fenice_lancio_inizio_v1) la sera del 5/10. Lucchetto e idempotenza del cron lancio-inizio: si scrive PRIMA dell''invio, si libera solo se Twilio risponde con un codice d''errore.';
