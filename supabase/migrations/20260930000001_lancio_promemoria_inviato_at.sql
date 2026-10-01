-- Lancio "Web Developer AI": il promemoria della mattina del 5/10 (PO 30/09/2026),
-- cron `lancio-promemoria`. Timbro-colonna per la stessa ragione di
-- `lancio_inizio_inviato_at` (20260925000001): il motore degli invii lo usa come lucchetto
-- con un compare-and-set prima di chiamare Twilio. Nullable, nessun indice, nessun backfill.

alter table public.conversations
  add column if not exists lancio_promemoria_inviato_at timestamptz;

comment on column public.conversations.lancio_promemoria_inviato_at is
  'Quando e'' partito il template del promemoria (fenice_lancio_promemoria_v1) la mattina del 5/10. Lucchetto e idempotenza del cron lancio-promemoria.';
