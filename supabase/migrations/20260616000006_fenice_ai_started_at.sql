-- Isola la cronologia gestita da Mario: la ricostruzione del contesto considera
-- solo i messaggi dall'arruolamento in poi (evita di mescolare vecchia storia CRM).

alter table conversations add column if not exists ai_started_at timestamptz;

-- conversazioni già gestite da Mario: parti da adesso
update conversations set ai_started_at = now() where ai_owner = 'mario' and ai_started_at is null;
