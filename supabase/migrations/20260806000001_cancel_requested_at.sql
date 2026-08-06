-- Marcatore di disdetta: valorizzato quando un lead con appuntamento GIÀ fissato
-- chiede di annullare o spostare. Serve a spegnere gli automatismi (promemoria
-- pre-call, solleciti video ai lead GDO), che oggi partono lo stesso perché
-- bot_outcome resta 'APPUNTAMENTO' e la disdetta è solo una nota al CRM:
-- 10 casi su 23 misurati il 04/08/2026, con lead che rispondono "avevo chiesto di
-- rimandare".
--
-- Colonna dedicata e NON un valore di bot_outcome: l'appuntamento resta terminale,
-- non si declassa mai (vedi resolveOutcomeAction). Qui si registra solo che il lead
-- l'ha chiesto — se poi il commerciale lo sistema, l'appuntamento è sempre quello.
alter table conversations add column if not exists cancel_requested_at timestamptz;

create index if not exists conversations_cancel_requested_at_idx
  on conversations(cancel_requested_at)
  where cancel_requested_at is not null;
