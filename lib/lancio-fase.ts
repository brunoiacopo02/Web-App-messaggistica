import { templateName } from './name';

/**
 * Lancio "Web Developer AI" (webinar 5/10/2026): stato, fasi e decisioni del turno.
 * Modulo PURO: niente env, niente DB, niente rete. Le costanti sono quelle della spec
 * (docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §3.2, §5.2).
 */

export const LANCIO_SLUG = 'webdev-2026-10';

export const LANCIO_FASI = [
  'attesa', 'posto_bloccato', 'link_inviato', 'post_pitch',
  'scelta_fatta', 'followup_inviato', 'restituito', 'chiuso',
] as const;
export type LancioFase = (typeof LANCIO_FASI)[number];

export function isLancioFase(v: unknown): v is LancioFase {
  return typeof v === 'string' && (LANCIO_FASI as readonly string[]).includes(v);
}

/** Con queste fasi il lancio è finito per quella chat: torna a Mario (o al GDO). */
export const LANCIO_FASI_TERMINALI: readonly LancioFase[] = ['chiuso', 'restituito'];

/** Le fasi che questo blocco (B1) sa gestire nel turno. Le altre arrivano con B4/B5. */
export const LANCIO_FASI_B1: readonly LancioFase[] = ['attesa', 'posto_bloccato'];
export const FASI_GESTITE_B1: ReadonlySet<string> = new Set<string>(LANCIO_FASI_B1);

/** Unica sorgente di verita' su "questa fase la sa gestire B1": la usano sia la
 *  decisione del turno sia chi deve capire se vale la pena interpellare il modello. */
export function faseGestitaB1(fase: string | null): boolean {
  return FASI_GESTITE_B1.has(fase ?? '');
}

/** La chat è del lancio e il lancio non è finito: Mario e i suoi cron stanno fuori. */
export function lancioInCorso(c: { lancio_slug?: string | null; lancio_fase?: string | null }): boolean {
  if (!c.lancio_slug) return false;
  return !(LANCIO_FASI_TERMINALI as readonly string[]).includes(c.lancio_fase ?? '');
}

/**
 * Lo stesso criterio di `lancioInCorso`, al contrario e in sintassi PostgREST, per le
 * query dei cron: `query.or(FILTRO_FUORI_LANCIO)`. Più `.or()` sulla stessa query si
 * sommano in AND, quindi si può aggiungere a query che ne hanno già uno.
 */
export const FILTRO_FUORI_LANCIO = 'lancio_slug.is.null,lancio_fase.in.(chiuso,restituito)';

// Testi fissi (spec §5.2). Il primo è verbatim dalla spec; gli altri seguono le stesse
// regole: niente link, niente prezzi, niente inviti a una call.
export const TESTO_POSTO_BLOCCATO =
  'Perfetto, il tuo posto è bloccato. Ti scrivo qui il 5 ottobre con il link per collegarti.';
export const TESTO_CONGEDO =
  'Va bene, grazie per avermelo detto: non ti scrivo più per questo evento. Buona giornata!';
export const TESTO_CHIUSURA_DOMANDE = 'Ci sentiamo il 5!';
export const TESTO_PASSAGGIO_UMANO = 'Certo, ti faccio contattare da una persona del team.';

/** Dopo tre scambi di domande il bot chiude e tace fino al link (spec §5.2). */
export const MAX_SCAMBI_DOMANDE = 3;

export type ClasseLancio = 'si' | 'no' | 'domanda' | 'incerto';

/** Una riga `messages` come la leggono i moduli del lancio. */
export type RigaLancio = {
  direction: string;
  body: string | null;
  template_sid: string | null;
  created_at?: string | null;
};

export type LancioAzione =
  | { kind: 'posto_bloccato'; testo: string }
  | { kind: 'congedo'; testo: string }
  | { kind: 'domanda'; chiudi: boolean }
  | { kind: 'passaggio_umano' }
  | { kind: 'silenzio'; motivo: 'gia_bloccato' | 'domande_esaurite' | 'fase_non_gestita' | 'classe_incerta' };

/**
 * Cosa fare in questo turno, data la fase e la classe del messaggio del lead.
 * `scambiDomande` = risposte a domande già uscite in questa chat (vedi
 * `contaScambiDomande`): alla terza si chiude, dalla quarta si tace.
 */
export function decideLancioTurno(i: {
  fase: string | null;
  classe: ClasseLancio;
  scambiDomande: number;
  passToHuman: boolean;
}): LancioAzione {
  if (i.passToHuman) return { kind: 'passaggio_umano' };
  if (!faseGestitaB1(i.fase)) return { kind: 'silenzio', motivo: 'fase_non_gestita' };
  if (i.classe === 'no') return { kind: 'congedo', testo: TESTO_CONGEDO };
  if (i.classe === 'si') {
    return i.fase === 'posto_bloccato'
      ? { kind: 'silenzio', motivo: 'gia_bloccato' }
      : { kind: 'posto_bloccato', testo: TESTO_POSTO_BLOCCATO };
  }
  if (i.classe === 'domanda') {
    if (i.scambiDomande >= MAX_SCAMBI_DOMANDE) return { kind: 'silenzio', motivo: 'domande_esaurite' };
    return { kind: 'domanda', chiudi: i.scambiDomande === MAX_SCAMBI_DOMANDE - 1 };
  }
  return { kind: 'silenzio', motivo: 'classe_incerta' };
}

const TESTI_FISSI = new Set([TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_PASSAGGIO_UMANO]);

/**
 * Le risposte a domande già uscite: gli outbound liberi (senza template) che non sono
 * uno dei testi fissi. Si legge dalle righe `messages` invece che da un contatore:
 * nessuna colonna in più, e il conto resta giusto anche se un turno muore a metà.
 * Per questo le risposte lancio partono come UNA bolla (mai `splitMarioMessages`).
 */
export function contaScambiDomande(rows: RigaLancio[]): number {
  return rows.filter((m) =>
    m.direction === 'out' && m.template_sid == null && !!m.body && !TESTI_FISSI.has(m.body.trim()),
  ).length;
}

/**
 * Il congedo e' gia' uscito su questa chat. Serve quando la fase NON e' stata portata a
 * `chiuso` perche' il CRM ha rifiutato il `DA_SCARTARE`: il turno dopo deve ritentare
 * l'esito senza mandare una seconda volta la stessa frase — e senza riclassificare, o un
 * "ok, va bene" scritto dopo il congedo gli bloccherebbe il posto a cui ha detto no.
 */
export function congedoGiaInviato(rows: RigaLancio[]): boolean {
  return rows.some(
    (m) => m.direction === 'out' && m.template_sid == null && (m.body ?? '').trim() === TESTO_CONGEDO,
  );
}

/**
 * Le righe che appartengono a QUESTO lancio. Su una chat riusata (guardia anti-doppione
 * dell'intake) `ai_started_at` non viene azzerato di proposito, quindi il drain carica
 * anche il giro precedente di Mario: senza questo taglio la prima domanda del lead
 * risulterebbe la quarta (silenzio) e il modello del lancio si leggerebbe un fissaggio
 * del GDO come contesto. Si taglia dal benvenuto del lancio se c'e' (nessuna query), se
 * no dall'istante dell'evento `lancio_intake`.
 */
export function tagliaRigheDalLancio(
  rows: RigaLancio[],
  welcomeSid: string | null | undefined,
  ingressoAt: string | null,
): RigaLancio[] {
  if (welcomeSid) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].template_sid === welcomeSid) return rows.slice(i);
    }
  }
  if (ingressoAt) return rows.filter((m) => !m.created_at || m.created_at >= ingressoAt);
  return rows;
}

const FASE_LABEL: Record<LancioFase, string> = {
  attesa: 'In attesa',
  posto_bloccato: 'Posto bloccato',
  link_inviato: 'Link inviato',
  post_pitch: 'Dopo il pitch',
  scelta_fatta: 'Scelta fatta',
  followup_inviato: 'Follow-up inviato',
  restituito: 'Restituito',
  chiuso: 'Chiuso',
};

/** Etichetta per i badge dei pannelli. */
export function lancioFaseLabel(fase: string | null): string {
  return isLancioFase(fase) ? FASE_LABEL[fase] : 'Lancio';
}

/** Corpo del template 1 (spec §7, testo approvato da Bruno il 14/09) con {{1}} risolto:
 *  è quello che finisce nella riga `messages` per i pannelli. */
export function lancioBenvenutoText(name?: string | null): string {
  return (
    `Ciao ${templateName(name)}, sono l'assistente virtuale di Fenice Academy. Complimenti per esserti iscritto ` +
    "alla lista d'attesa dell'evento del 5 ottobre: ti invieremo il link per collegarti alla live " +
    'direttamente qui su WhatsApp il giorno stesso. Rispondi a questo messaggio se sei realmente ' +
    'interessato, per bloccare il posto.'
  );
}
