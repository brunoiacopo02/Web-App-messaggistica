alter table conversations
  add column if not exists gdo_appuntamento_set_at timestamptz;
comment on column conversations.gdo_appuntamento_set_at is 'Quando il CRM ci ha dato l''ultima data della call (primo fissaggio o spostamento): conta per quando chiama Noemi';
