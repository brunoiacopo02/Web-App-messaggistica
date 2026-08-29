-- Che fine fa una richiesta di parlare con una persona.
--
-- Fino al 29/08/2026 la consegnavamo e finiva li': mandavamo `CONTATTO_UMANO` al CRM e
-- non sapevamo piu' niente -- se qualcuno l'avesse presa in carico, quando, e com'era
-- andata. Il bot restava zitto su quella chat all'infinito anche quando il caso era
-- chiuso da settimane, e nessuno dei due poteva dire se la coda funzionasse.
--
-- Dal 29/08 il CRM porta il blocco `contattoUmano` dentro le righe che gia' serve su
-- `POST /api/bot/lead-status`: nessun endpoint nuovo, nessun segreto nuovo, e l'arretrato
-- rientra da solo perche' il canale e' a cursore. Queste colonne sono la copia locale di
-- quel blocco, sulla stessa riga per lead del resto dello stato post-appuntamento.
--
-- `richiesta_il` e' la loro data, non la nostra: serve a incrociare le due code quando i
-- conti non tornano -- come il 64 contro 59 del 29/08, dove la differenza erano 12 nostre
-- chat passate a una persona che una notifica non l'avevano mai generata.
alter table crm_lead_status add column if not exists contatto_umano_stato text;
alter table crm_lead_status add column if not exists contatto_umano_preso_da text;
alter table crm_lead_status add column if not exists contatto_umano_preso_il timestamptz;
alter table crm_lead_status add column if not exists contatto_umano_esito text;
alter table crm_lead_status add column if not exists contatto_umano_esito_il timestamptz;
alter table crm_lead_status add column if not exists contatto_umano_nota text;
alter table crm_lead_status add column if not exists contatto_umano_richiesta_il timestamptz;

-- Chi aspetta ancora, in ordine di attesa: e' l'unica interrogazione che faremo davvero
-- su queste colonne, e senza indice va in sequenziale su tutta la tabella.
create index if not exists crm_lead_status_contatto_umano_aperti_idx
  on crm_lead_status(contatto_umano_richiesta_il)
  where contatto_umano_stato is not null and contatto_umano_stato <> 'closed';
