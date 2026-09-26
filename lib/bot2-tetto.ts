/**
 * Il tetto giornaliero del secondo numero ("bot 2").
 *
 * Un numero nuovo si brucia con il volume, non con il tempo: il 15/09/2026 un
 * picco di aperture ha portato il numero storico a qualita' LOW, ed e' il
 * motivo per cui esiste tutto questo lavoro. Il PO ha fissato **150 aperture al
 * giorno** per il numero nuovo, e vuole che sia un tetto vero, non un'intenzione.
 *
 * Questo modulo e' il blocco che sta DOVE PARTE IL MESSAGGIO. Ce n'e' un altro a
 * monte, nel CRM, che evita di mandare qui lead che tanto verrebbero respinti:
 * sono due controlli indipendenti, e questo e' quello che conta, perche' e'
 * l'ultimo prima di Twilio.
 *
 * **Fallisce chiuso.** Se il conteggio non si puo' fare — query in errore,
 * numero non configurato, env illeggibile — la risposta e' NO: si ripiega sul
 * numero storico. Sbagliare in quella direzione costa un'apertura da un numero
 * che regge 10.000 contatti al giorno; sbagliare nell'altra costa il numero.
 */

export const TETTO_BOT2_DEFAULT = 150;

/** Il tetto, da `BOT2_DAILY_CAP`. Un valore illeggibile vale il default. */
export function tettoBot2(): number {
  const raw = process.env.BOT2_DAILY_CAP?.trim();
  if (!raw) return TETTO_BOT2_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    console.error(`[bot2] BOT2_DAILY_CAP="${raw}" non e' un intero fra 0 e 10000: uso ${TETTO_BOT2_DEFAULT}`);
    return TETTO_BOT2_DEFAULT;
  }
  return n;
}

/** Mezzanotte di oggi a Roma, in ISO, per contare il giorno civile giusto. */
export function inizioGiornataRoma(adesso: Date = new Date()): string {
  const g = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(adesso);
  // L'offset di Roma cambia due volte l'anno: lo si chiede alla stessa data
  // invece di scriverlo a mano, cosi' l'ora legale non sposta il conteggio.
  const off = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome', timeZoneName: 'longOffset',
  }).format(adesso).match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? '+01:00';
  return `${g}T00:00:00${off}`;
}

export interface EsitoTetto {
  /** true = si puo' aprire sul numero nuovo. */
  consentito: boolean;
  /** Quante aperture risultano gia' fatte oggi su quel numero. */
  oggi: number;
  tetto: number;
  motivo: 'ok' | 'tetto_raggiunto' | 'conteggio_fallito' | 'numero_assente';
}

type Supa = {
  from: (t: string) => {
    select: (c: string, o?: { count: 'exact'; head: true }) => {
      eq: (k: string, v: unknown) => {
        gte: (k: string, v: unknown) => Promise<{ count: number | null; error: unknown }>;
      };
    };
  };
};

/**
 * Quante conversazioni sono NATE oggi (giorno di Roma) con quel `wa_number`.
 * E' la prova di cosa e' davvero partito, non un contatore a parte. null =
 * conteggio non riuscito: chi chiama deve trattarlo come "numero chiuso".
 */
export async function chatNateOggi(supabase: Supa, numero: string, adesso: Date = new Date()): Promise<number | null> {
  try {
    const { count, error } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('wa_number', numero)
      .gte('created_at', inizioGiornataRoma(adesso));
    if (error || count === null || count === undefined) {
      console.error(`[numeri] conteggio di oggi per ${numero} non riuscito`, error);
      return null;
    }
    return count;
  } catch (e) {
    console.error(`[numeri] conteggio di oggi per ${numero} esploso`, e);
    return null;
  }
}

/**
 * Si puo' aprire un'altra conversazione sul numero nuovo, oggi?
 *
 * Conta le conversazioni NATE oggi con quel `wa_number`, che e' la prova di
 * cosa e' davvero partito — non un contatore a parte, che si sfasa al primo
 * riavvio e mente proprio quando serve.
 */
export async function puoAprireSuBot2(
  supabase: Supa,
  numeroSecondo: string | undefined,
  adesso: Date = new Date(),
): Promise<EsitoTetto> {
  const tetto = tettoBot2();
  if (!numeroSecondo) {
    return { consentito: false, oggi: 0, tetto, motivo: 'numero_assente' };
  }
  const count = await chatNateOggi(supabase, numeroSecondo, adesso);
  if (count === null) return { consentito: false, oggi: 0, tetto, motivo: 'conteggio_fallito' };
  if (count >= tetto) return { consentito: false, oggi: count, tetto, motivo: 'tetto_raggiunto' };
  return { consentito: true, oggi: count, tetto, motivo: 'ok' };
}
