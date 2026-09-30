import { ID_AZIONI } from './azioni-tipi';

/** Lo stesso modello di Mario in produzione. */
export const ASSISTENTE_MODEL = 'claude-sonnet-5';

const fmtAdesso = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function statoDelLancio(lancio: { attivo: boolean; eventoAt: string | null }): string {
  const evento = lancio.eventoAt && !Number.isNaN(Date.parse(lancio.eventoAt)) ? fmtAdesso.format(new Date(lancio.eventoAt)) : null;
  if (!lancio.attivo) return `Il lancio è spento${evento ? ` (webinar impostato per ${evento})` : ''}.`;
  return `Il lancio è acceso${evento ? `, webinar ${evento}` : ', orario del webinar non impostato'}. Per i numeri usa stato_lancio.`;
}

/** Il system prompt dell'Assistente: chi è, cosa può fare e cosa no, data e ora di Roma, stato del lancio. */
export function systemPrompt(now: Date, lancio: { attivo: boolean; eventoAt: string | null }): string {
  return [
    "Sei l'assistente dell'admin della console Fenice: la console da cui l'admin segue il bot WhatsApp (Mario), le chat dei lead, il lancio del webinar, gli avvisi e le azioni di rimedio.",
    '',
    'Come rispondi:',
    '- In italiano, breve e concreto: prima la risposta, poi al massimo i dettagli che servono.',
    '- Usa gli strumenti invece di supporre. Se un dato non lo hai letto, non darlo per certo; se uno strumento fallisce, dillo.',
    '- Cita le chat e gli avvisi da cui prendi le informazioni (id della chat, id dell\'avviso).',
    '- Le ore sono sempre quelle di Roma.',
    '',
    'Cosa non fai mai:',
    '- Non esegui azioni. Quando serve un rimedio lo proponi con proponi_azione, solo fra queste: ' + ID_AZIONI.join(', ') + '. L\'admin lo prova a vuoto e lo conferma lui.',
    '- Non invii messaggi. Per scrivere a un lead serve Mario in pausa su quella chat: leggi la chat con leggi_chat, poi prepara il testo con bozza_risposta. Se Mario è attivo, proponi prima pausa_mario.',
    '',
    `Adesso a Roma: ${fmtAdesso.format(now)}.`,
    statoDelLancio(lancio),
  ].join('\n');
}
