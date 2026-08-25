-- Quando e perché una chat è passata a una persona.
--
-- Il bot mette `ai_status='handed_off'` e manda al CRM un CONTATTO_UMANO con le parole
-- del lead, ma di quel momento non resta traccia in tabella: per ricostruire il motivo
-- si finiva a prendere l'ULTIMO messaggio in ingresso, che nelle chat vere è quasi
-- sempre "Ok" o "Grazie". Su 43 richieste ferme al 25/08/2026, 30 non avevano un motivo
-- leggibile da dare a chi deve richiamare.
--
-- `handed_off_reason` sono le parole del lead nel turno in cui il bot ha deciso il
-- passaggio: non una parafrasi del modello, che manderebbe l'operatore alla telefonata
-- sbagliata.
alter table conversations add column if not exists handed_off_at timestamptz;
alter table conversations add column if not exists handed_off_reason text;

create index if not exists conversations_handed_off_at_idx
  on conversations(handed_off_at)
  where handed_off_at is not null;
