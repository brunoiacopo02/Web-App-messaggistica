import { funnelDaPrimoMessaggio } from './persona';

/**
 * Chi ci scrive per primo sul numero Fenice arriva da tre porte, e le tre non devono
 * mai confondersi (vincolo del PO, 14/09: "i lead di Telegram che scrivono sono roba
 * molto diversa"):
 *
 *  - il link del canale Telegram, che consegna una frase precompilata → TELEGRAM,
 *    flusso Mario standard, lead entrante normale sul CRM;
 *  - il pulsante WhatsApp mostrato la sera del webinar (spec lancio §6.3) → la chat
 *    entra nel lancio in fase `post_pitch`; se nasce adesso, il CRM la crea nel bucket
 *    del lancio;
 *  - tutto il resto → INBOUND, Mario standard.
 *
 * La provenienza Telegram si legge dal PRIMO inbound della conversazione (chi riscrive
 * dopo giorni non cambia porta) OPPURE dall'inbound CORRENTE, se contiene la stessa
 * frase: un lead che ha scritto altro all'apertura e poi manda la frase del canale (un
 * "avanti e indietro" fra bot diversi, o un incollato in ritardo) resta comunque
 * TELEGRAM — e non deve MAI confondersi con INBOUND o col lancio (vincolo PO 14/09).
 * Il pulsante invece scatta SOLO sull'inbound CORRENTE, e vince su tutto: il lead della
 * lista d'attesa ha la chat aperta da settimane (magari con un primo inbound Telegram),
 * e la preme la sera del 5 — e' quel messaggio che conta, non il primo.
 */

export const PROVENIENZA_LANCIO_WEBDEV = 'Lancio Web Dev AI' as const;

/** Testo precompilato del link wa.me del pulsante (spec §6.3). Cambiarlo qui = cambiarlo nella pagina. */
export const TESTO_PULSANTE_WEBINAR = 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀';

/** Marker del pulsante (spec §6.3). Sul nome della live, non sull'intera frase: un
 *  lead che aggiunge una riga o perde l'emoji resta riconosciuto. */
export const MARKER_PULSANTE_WEBINAR = /live web developer ai/i;

export type ProvenienzaLeadEntrante = 'TELEGRAM' | 'INBOUND' | typeof PROVENIENZA_LANCIO_WEBDEV;

export type EsitoPrimoMessaggio =
  | { tipo: 'telegram'; provenienza: 'TELEGRAM' }
  | { tipo: 'inbound'; provenienza: 'INBOUND' }
  | { tipo: 'lancio_pulsante'; provenienza: typeof PROVENIENZA_LANCIO_WEBDEV };

export function isMarkerPulsanteWebinar(body: string | null | undefined): boolean {
  return MARKER_PULSANTE_WEBINAR.test(body ?? '');
}

/**
 * A questo lead va mandato il riaggancio di Marta ("ci eravamo persi a meta' discorso")?
 *
 * No a chi e' arrivato dal pulsante del webinar: quella chat entra nel lancio, e a
 * rispondergli ci pensa il turno del lancio nel drain. Il riaggancio di Marta sopra un
 * lead del lancio sarebbe una seconda voce sulla stessa persona, per giunta con un testo
 * che col webinar non c'entra niente.
 */
export function vaRiagganciato(esito: EsitoPrimoMessaggio): boolean {
  return esito.tipo !== 'lancio_pulsante';
}

export function classificaPrimoMessaggio(input: {
  primoInbound: string | null | undefined;
  inboundCorrente: string | null | undefined;
}): EsitoPrimoMessaggio {
  if (isMarkerPulsanteWebinar(input.inboundCorrente)) {
    return { tipo: 'lancio_pulsante', provenienza: PROVENIENZA_LANCIO_WEBDEV };
  }
  // OR e non solo il primo: un Telegram scritto ORA (dopo un primo messaggio diverso)
  // deve restare TELEGRAM tanto quanto un Telegram scritto all'apertura — altrimenti
  // due lead con la stessa identica frase in mano finirebbero su funnel diversi solo
  // per l'ordine in cui l'hanno scritta.
  const isTelegram =
    funnelDaPrimoMessaggio(input.primoInbound) === 'TELEGRAM' ||
    funnelDaPrimoMessaggio(input.inboundCorrente) === 'TELEGRAM';
  return isTelegram
    ? { tipo: 'telegram', provenienza: 'TELEGRAM' }
    : { tipo: 'inbound', provenienza: 'INBOUND' };
}
