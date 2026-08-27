-- Cosa succede al lead dopo che il bot ha fissato l'appuntamento.
--
-- Il nostro database si fermava al fissaggio: non sapevamo se il lead veniva confermato,
-- se si presentava alla call, se comprava. Ottimizzare in quelle condizioni vuol dire
-- poter far crescere il NUMERO di appuntamenti peggiorandone la qualita' senza vederlo.
-- Dal 26/08/2026 il CRM espone `POST /api/bot/lead-status` (contratto v1.5) e questa
-- tabella e' la copia locale di quello stato.
--
-- Una riga per lead, non per evento: il CRM serve lo STATO CORRENTE e la stessa riga
-- ricompare a ogni modifica. `lead_id` e' quindi la chiave primaria e si sovrascrive.
create table if not exists crm_lead_status (
  lead_id text primary key,
  -- La conversazione del bot, quando riusciamo ad agganciarla. Nullable: il CRM puo'
  -- servire un lead di cui abbiamo perso la chat, e perdere il dato sarebbe peggio.
  conversation_id bigint references conversations(id) on delete set null,

  status text,
  appointment_date timestamptz,
  appointment_created_at timestamptz,

  -- Le Conferme: confermato | scartato | da_rifissare
  conferme_outcome text,
  conferme_outcome_at timestamptz,
  conferme_discard_reason text,

  -- La metrica vera: non quanti appuntamenti si fissano, ma quanti arrivano alla call.
  presented boolean not null default false,
  presented_at timestamptz,

  -- La trattativa: Chiuso | Non chiuso | Sparito
  sales_outcome text,
  sales_outcome_at timestamptz,
  sold boolean not null default false,
  sold_product text,
  sold_amount_eur numeric,

  discard_reason text,
  agenda_status text,

  -- L'istante del CRM, da cui riparte il cursore. Il nostro e' `synced_at`: tenerli
  -- separati serve a distinguere "il lead non cambia" da "il cron non gira".
  crm_updated_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create index if not exists crm_lead_status_conversation_idx
  on crm_lead_status(conversation_id)
  where conversation_id is not null;

create index if not exists crm_lead_status_updated_idx
  on crm_lead_status(crm_updated_at desc);

-- Per le domande che ci interessano davvero: chi si e' presentato, chi ha comprato.
create index if not exists crm_lead_status_presented_idx
  on crm_lead_status(presented, sold);
