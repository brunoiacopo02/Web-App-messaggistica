/**
 * Il conteggio delle aperture di oggi per un numero, e il giorno civile di Roma
 * su cui si conta.
 *
 * Fino al 26/09/2026 questo modulo era anche il tetto del "bot 2"
 * (`puoAprireSuBot2`/`tettoBot2`/`BOT2_DAILY_CAP`, un solo numero nuovo). Con il
 * parco numeri a N il tetto e' diventato una mappa per numero in
 * `app_settings.tetti_numeri` (vedi `lib/tetti-numeri.ts` e
 * `lib/scelta-mittente.ts`, che e' chi decide davvero il mittente di una chat
 * nuova); questo modulo resta perche' `chatNateOggi` — la prova di cosa e'
 * davvero partito, non un contatore a parte — serve ancora a quella scelta.
 *
 * **Fallisce chiuso.** Se il conteggio non si puo' fare — query in errore,
 * numero non configurato, env illeggibile — chi chiama tratta il numero come
 * chiuso e ripiega sul numero storico. Sbagliare in quella direzione costa
 * un'apertura da un numero che regge 10.000 contatti al giorno; sbagliare
 * nell'altra costa il numero.
 */

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
