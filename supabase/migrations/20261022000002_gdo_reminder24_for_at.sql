alter table conversations
  add column if not exists gdo_reminder24_for_at timestamptz;
comment on column conversations.gdo_reminder24_for_at is 'Data della call a cui si riferisce il promemoria del giorno prima gia'' preso per il lead GDO (dedup del promemoria)';
