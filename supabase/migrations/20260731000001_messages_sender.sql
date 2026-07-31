-- Attribuzione dei messaggi in uscita.
--
-- Fino a qui una risposta del bot e una scritta a mano da un operatore erano righe
-- identiche (direction='out', is_template=false, template_sid=null): il pannello di
-- supervisione /chat non poteva distinguerle. `sender` registra chi ha prodotto il testo.

alter table public.messages add column if not exists sender text;

comment on column public.messages.sender is
  'Chi ha prodotto il messaggio in uscita: bot (turno di Mario) | automazione (template programmato) | operatore (persona dalla UI). Nullo sugli inbound.';

-- Backfill dello storico. È una STIMA dichiarata, non un dato registrato: la UI marca
-- come "stimato" tutto ciò che precede l'applicazione di questa migration.

-- 1) i template sono sempre automazione
update public.messages
   set sender = 'automazione'
 where sender is null and direction = 'out' and is_template = true;

-- 2) testo libero in uscita dentro una chat governata dal bot: quasi sempre Mario
update public.messages m
   set sender = 'bot'
  from public.conversations c
 where m.conversation_id = c.id
   and m.sender is null
   and m.direction = 'out'
   and coalesce(m.is_template, false) = false
   and c.ai_owner = 'mario';

-- 3) tutto il resto in uscita: una persona dalla UI
update public.messages
   set sender = 'operatore'
 where sender is null and direction = 'out';
