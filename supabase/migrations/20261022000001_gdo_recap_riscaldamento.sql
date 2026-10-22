alter table conversations
  add column if not exists gdo_recap_for_at timestamptz,
  add column if not exists gdo_recap_sent_at timestamptz,
  add column if not exists gdo_warmup_step smallint,
  add column if not exists gdo_warmup_closed_at timestamptz;
comment on column conversations.gdo_recap_for_at is 'Data della call a cui si riferisce l''ultimo recap mandato al lead GDO';
comment on column conversations.gdo_warmup_step is 'Riscaldamento lead GDO: null mai aperto, 1 fatta domanda 1, 2 fatta domanda 2, 3 chiuso';
