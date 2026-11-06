-- La finestra delle 24 ore di WhatsApp vale per COPPIA (numero nostro, numero del lead),
-- non per chat (06/11/2026). `last_inbound_at` dice QUANDO il lead ha scritto l'ultima
-- volta, non A QUALE dei nostri numeri: con piu' numeri sulla stessa chat il bot poteva
-- credere aperta una finestra che su quel mittente era chiusa, mandare testo libero e
-- prendere 63016.
--
-- Il webhook in ingresso scrive qui il `To` di ogni inbound, insieme a `last_inbound_at`.
-- Forma: `whatsapp:+39…`, come `wa_number`.
alter table public.conversations
  add column if not exists last_inbound_number text;

comment on column public.conversations.last_inbound_number is
  'Numero nostro (whatsapp:+39...) a cui e'' arrivato l''ultimo inbound: la finestra 24h vale su questo numero.';

-- Storico: il webhook dal 05/10 sposta la chat sul numero a cui il lead scrive (se e' del
-- bot), quindi `wa_number` e' la migliore stima del numero dell'ultimo inbound. Le chat
-- mai risposte restano NULL.
update public.conversations
   set last_inbound_number = wa_number
 where last_inbound_at is not null
   and last_inbound_number is null
   and wa_number is not null;
