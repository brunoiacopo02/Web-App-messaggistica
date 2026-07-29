-- Lucchetto di concorrenza del bot su colonna dedicata: ai_status torna a
-- descrivere solo lo stato di prodotto della conversazione.
alter table conversations add column if not exists ai_lock_at timestamptz;

create index if not exists conversations_ai_lock_at_idx
  on conversations(ai_lock_at)
  where ai_lock_at is not null;
