// Solo i tipi del registro azioni della Console: li consuma il Task 10 (registro) e gli avvisi (Task 9).
export const ID_CRON = [
  'lancio-aperture',
  'lancio-zoom',
  'lancio-followup',
  'lancio-restituzioni',
  'riapri-mute',
  'adotta-mai-risposti',
  'bot-followups',
  'crm-lead-status',
] as const;
export type IdCron = (typeof ID_CRON)[number];

export const ID_AZIONI = [
  'rinvia_esiti_403',
  'recupera_agende_consegnate',
  'rinvia_esito',
  'rilancia_cron',
  'interruttore',
  'pausa_mario',
  'riprendi_mario',
] as const;
export type IdAzione = (typeof ID_AZIONI)[number];
