alter table crm_lead_status
  add column if not exists recall_at timestamptz;
comment on column crm_lead_status.recall_at is 'Richiamo blu delle Conferme (lead parcheggiato senza data, da_rifissare): quando Noemi richiama il lead per fissare o confermare la call';

alter table conversations
  add column if not exists conf_richiamo_sollecito_for_at timestamptz;
comment on column conversations.conf_richiamo_sollecito_for_at is 'Il richiamo delle Conferme a cui si riferisce il sollecito gia'' preso (dedup del sollecito: un richiamo spostato lo riapre)';
