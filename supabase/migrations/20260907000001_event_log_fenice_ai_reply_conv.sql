-- La guardia anti-loop del re-drive, resa leggibile senza scandire event_log.
--
-- Il cron `bot-followups`, prima di rispondere a un inbound rimasto scoperto, chiede
-- se un drain ha gia' girato dopo quell'inbound:
--
--   select created_at from event_log
--    where type = 'fenice_ai_reply'
--      and payload->>'conversationId' = $1
--      and created_at >= $2
--
-- Su `payload->>'conversationId'` non c'era nessun indice. event_log e' una tabella di
-- sola aggiunta che cresce di ~17.000 righe al giorno (570.000 il 07/09/2026, di cui
-- ~1.800 fenice_ai_reply al giorno): ogni chiamata estraeva il campo JSON riga per
-- riga. A freddo l'ho cronometrata in 5,9 secondi. E' il motivo per cui la durata del
-- cron saliva in modo lineare da settimane -- non cresceva il numero di lead, cresceva
-- questa tabella -- fino a sbattere sui 300s di Vercel il 02/09/2026.
--
-- Parziale su `type` come l'indice del recupero NR: e' l'unico tipo interrogato per
-- conversazione, e restringerlo tiene l'indice piccolo (~2% delle righe).
-- `created_at` in coda perche' la query filtra anche su quello.
create index if not exists event_log_fenice_ai_reply_conv_idx
  on event_log ((payload->>'conversationId'), created_at)
  where type = 'fenice_ai_reply';
