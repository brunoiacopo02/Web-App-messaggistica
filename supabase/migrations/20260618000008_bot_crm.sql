-- Integrazione Bot Fissatore ↔ CRM: routing del callback + stato esito sulla conversazione.

alter table conversations
  add column if not exists crm_lead_id        text,
  add column if not exists crm_funnel         text,
  add column if not exists bot_outcome        text,
  add column if not exists bot_outcome_at     timestamptz,
  add column if not exists bot_scheduled_at   timestamptz,
  add column if not exists bot_report         jsonb,
  add column if not exists bot_followups_sent int not null default 0;

create index if not exists conversations_crm_lead_id_idx on conversations(crm_lead_id);
