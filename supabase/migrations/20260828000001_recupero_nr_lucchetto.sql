-- Il lucchetto del recupero delle mancate risposte al telefono, reso davvero atomico.
--
-- `/api/bot/call-attempt` decide se scrivere a un lead che le Conferme non sono
-- riuscite a sentire. Per non mandargli due volte lo stesso messaggio leggeva
-- l'evento `recupero_nr_inviato` prima dell'invio e lo scriveva dopo: in mezzo ci sono
-- la chiamata al modello e gli invii Twilio, cioe' secondi. Due POST ravvicinati -- il
-- doppio clic che la specifica del CRM promette innocuo -- leggevano entrambi "non
-- inviato" e mandavano entrambi.
--
-- Con questo indice il claim e' la insert stessa: chi arriva secondo si prende un
-- 23505 (unique_violation) e il route esce con `gia_inviato` senza scrivere al lead.
--
-- Parziale su `type` per due motivi: e' l'unico tipo di evento che ha bisogno di questa
-- unicita', e event_log e' una tabella di sola aggiunta dove ogni altro tipo puo'
-- legittimamente ripetersi sulla stessa conversazione.
create unique index if not exists event_log_recupero_nr_inviato_uniq
  on event_log ((payload->>'conversationId'), (payload->>'tentativo'))
  where type = 'recupero_nr_inviato';
