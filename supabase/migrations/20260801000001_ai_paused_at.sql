-- Fermo manuale del bot su una singola conversazione: valorizzato quando un umano
-- prende le redini della chat dal pannello. Colonna dedicata, non un valore di
-- ai_status, perché il `finally` di drainMarioReplies rimaneggia lo stato a ogni
-- turno e sovrascriveva il fermo (conv 3748, 1/08/2026).
alter table conversations add column if not exists ai_paused_at timestamptz;

create index if not exists conversations_ai_paused_at_idx
  on conversations(ai_paused_at)
  where ai_paused_at is not null;
