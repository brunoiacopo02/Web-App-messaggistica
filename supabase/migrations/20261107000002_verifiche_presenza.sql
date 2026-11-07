-- Verifica presenza un'ora prima della call (PO 07/11/2026), lib/verifica-presenza.ts.
-- Una riga per (chat, data della call): l'INSERT e' la presa prima dell'invio, il vincolo
-- UNIQUE impedisce il doppio invio. Uno spostamento della call (data nuova) la riapre.
create table if not exists verifiche_presenza (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  crm_lead_id text not null,
  appuntamento_at timestamptz not null,
  inviata_at timestamptz,
  canale text,
  esito text not null default 'in_attesa',
  esito_at timestamptz,
  risposta text,
  crm_avvisato_at timestamptz,
  crm_errore text,
  created_at timestamptz not null default now(),
  constraint verifiche_presenza_unica unique (conversation_id, appuntamento_at),
  constraint verifiche_presenza_esito check (esito in ('in_attesa', 'confermato', 'non_conferma', 'risposta'))
);

create index if not exists verifiche_presenza_appuntamento_idx on verifiche_presenza (appuntamento_at);

alter table verifiche_presenza enable row level security;

comment on table verifiche_presenza is 'Verifica presenza a T-1h sui lead confermati dalle Conferme il giorno prima: presa, invio, risposta del lead e avviso al CRM';
