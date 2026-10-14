-- Funnel Professioni (PO 14/10/2026, spec 2026-10-14-funnel-professioni-design.md).
-- `professione`: slug del corso scelto sulla landing (lib/professioni.ts), scritto quando il
-- lead manda la frase "scheda del corso". `scheda_inviata_at`: lucchetto e idempotenza
-- dell'invio del PDF (una volta sola per chat). Nullable, nessun indice, nessun backfill.

alter table public.conversations
  add column if not exists professione text,
  add column if not exists scheda_inviata_at timestamptz;

comment on column public.conversations.professione is
  'Slug del corso del funnel Professioni (sviluppatore_web_ai, video_editor, project_manager, graphic_designer, copywriter, social_media_manager).';
comment on column public.conversations.scheda_inviata_at is
  'Quando e'' partita la scheda PDF del corso. Lucchetto compare-and-set di lib/scheda-invio.ts.';
