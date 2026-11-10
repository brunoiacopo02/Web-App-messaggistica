import type { getSupabaseAdmin } from './supabase/admin';
import {
  FINE_BLACK_FRIDAY_DEFAULT_MS, INIZIO_BLACK_FRIDAY_MS, parsePosti, parseScadenza, righeFattiOffertaBlackFriday,
  SETTING_POSTI, SETTING_SCADENZA, type SettingsBlackFriday,
} from './black-friday';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Offerta Black Friday anche ai lead evergreen (PO 10/11/2026): "ai lead evergreen che
 * fissi, quando gli fai il pitch, digli dell'offerta e di tutti i benefici e mandagli
 * quella VSL. Fino a fine novembre".
 *
 * Evergreen = ogni chat che Mario porta al pitch fuori dal funnel Black Friday: Corso 10
 * ore, Job Simulator, Telegram, Professioni, Social... Restano fuori le chat che hanno gia'
 * un flusso con la sua offerta o il suo video (lancio, studenti, postino dei GDO) e chi ha
 * gia' ricevuto un video conferenza-* (niente secondo video, caso Luciani).
 *
 * I fatti dell'offerta sono gli stessi del funnel BF (`righeFattiOffertaBlackFriday`):
 * nessun testo nuovo sull'offerta. Qui c'e' solo COME innestarli nel flusso standard.
 *
 * Interruttore: `app_settings.offerta_bf_evergreen` ('on'/'off', true/false). Assente =
 * spento. Si spegne da solo dopo `black_friday_scadenza` (o la fine del 30/11 se manca),
 * e con `BLACK_FRIDAY_FUNNEL=0` (l'emergenza del funnel BF spegne anche questo). Il `1`
 * delle prove del funnel BF qui NON vale: dopo la scadenza nessuno deve ricordarsi di
 * spegnerlo.
 */
export const SETTING_OFFERTA_BF_EVERGREEN = 'offerta_bf_evergreen' as const;

/** In `event_log`, una volta per conversazione: a questo lead Mario ha presentato l'offerta. */
export const EVENTO_OFFERTA_BF_EVERGREEN = 'offerta_bf_evergreen_presentata' as const;

/** Prima riga della nota di APPUNTAMENTO al CRM: la leggono Conferme e venditore. */
export const PREFISSO_NOTA_OFFERTA_BF = 'OFFERTA BLACK FRIDAY presentata in chat dal bot (prezzo 1.000-3.000 €, garanzia collocato o rimborsato, corso IA in regalo, regalo tech per l\'Exclusive) e VSL dell\'offerta inviata.';

export function interruttoreAcceso(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (typeof raw !== 'string') return false;
  return ['on', '1', 'true', 'acceso', 'si', 'sì'].includes(raw.trim().toLowerCase());
}

export function offertaBfEvergreenAttiva(i: {
  interruttore: unknown;
  env?: string | null;
  nowMs: number;
  scadenzaAtMs?: number | null;
}): boolean {
  if (!interruttoreAcceso(i.interruttore)) return false;
  if (['0', 'false', 'off'].includes((i.env ?? '').trim().toLowerCase())) return false;
  const fine = i.scadenzaAtMs ?? FINE_BLACK_FRIDAY_DEFAULT_MS;
  return i.nowMs >= INIZIO_BLACK_FRIDAY_MS && i.nowMs <= fine;
}

export type SettingsOffertaBfEvergreen = SettingsBlackFriday & { interruttore: unknown };

/** Una lettura sola: interruttore, scadenza e posti. */
export async function leggiSettingsOffertaBfEvergreen(supabase: Supa): Promise<SettingsOffertaBfEvergreen> {
  const { data } = await supabase.from('app_settings').select('key, value')
    .in('key', [SETTING_OFFERTA_BF_EVERGREEN, SETTING_SCADENZA, SETTING_POSTI]);
  const byKey = new Map(((data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  return {
    interruttore: byKey.get(SETTING_OFFERTA_BF_EVERGREEN) ?? null,
    scadenza: parseScadenza(byKey.get(SETTING_SCADENZA)),
    posti: parsePosti(byKey.get(SETTING_POSTI)),
  };
}

const VIDEO_CONFERENZA = /corso\.feniceacademy\.it\/conferenza-/i;

/** In chat e' gia' uscito un video conferenza-* (nostro o del GDO): non se ne manda un secondo. */
export function haVideoConferenza(rows: readonly { direction: string; body: string | null }[]): boolean {
  return rows.some((m) => m.direction === 'out' && VIDEO_CONFERENZA.test(m.body ?? ''));
}

/**
 * La chat e' candidata: evergreen e senza un video conferenza gia' uscito. Su una chat
 * con APPUNTAMENTO vale solo se l'offerta gliel'abbiamo gia' presentata noi (evento): chi ha
 * fissato prima del 10/11 resta col flusso di prima e non riceve niente di nuovo.
 */
export function offertaBfEvergreenVale(i: {
  attiva: boolean;
  vslLink: string | null;
  /** La chat e' del funnel BF, del lancio, studenti o postino: hanno il loro flusso. */
  altroFlusso: boolean;
  esitoInPiedi: string | null;
  giaPresentata: boolean;
  rows: readonly { direction: string; body: string | null }[];
}): boolean {
  if (!i.attiva || !i.vslLink?.trim() || i.altroFlusso) return false;
  if (haVideoConferenza(i.rows)) return false;
  if (i.esitoInPiedi === 'APPUNTAMENTO' && !i.giaPresentata) return false;
  return true;
}

/** La nota dell'APPUNTAMENTO al CRM, con in testa l'offerta presentata (una volta). */
export function notaAppuntamentoConOfferta(note: string | null | undefined): string {
  const n = (note ?? '').trim();
  if (n.startsWith(PREFISSO_NOTA_OFFERTA_BF)) return n;
  return n ? `${PREFISSO_NOTA_OFFERTA_BF}\n${n}` : PREFISSO_NOTA_OFFERTA_BF;
}

/**
 * La nota di contesto per il lead evergreen: i fatti del BF + dove metterli nel flusso
 * standard. Il pitch, il tono e le fasi restano quelli del manuale.
 */
export function offertaBfEvergreenContextNote(i: {
  vslLink: string;
  settings: SettingsBlackFriday;
  nowMs: number;
  /** La call c'e' gia' (fissata col BF): niente nuova proposta. */
  callGiaFissata: boolean;
}): string {
  const scadenza = i.settings.scadenza && i.settings.scadenza.atMs > i.nowMs ? i.settings.scadenza : null;
  const posti = i.settings.posti;
  const vsl = i.vslLink.trim();
  const righe = [
    "OFFERTA BLACK FRIDAY ATTIVA (vale anche per questo lead, che NON e' arrivato dal Black Friday): fino a fine mese c'e' un'offerta sui nostri percorsi e gliela presenti quando arrivi al pitch. Il flusso, le fasi, le domande e il tono restano quelli del manuale: aggiungi l'offerta, non riscrivere il resto.",
    `REGOLA SUL VIDEO, PREVALE SUL MANUALE: per questo lead il video e' UNO SOLO, quello dell'offerta Black Friday: ${vsl} . Nel passaggio 3 della CONFERMA POST-APPUNTAMENTO e in ogni altro punto in cui manderesti un video usi SOLO questo link: i quattro link conferenza-* per questo lead NON esistono, non scriverli mai. Non dire quanto dura (niente "20 minuti").`,
    ...righeFattiOffertaBlackFriday({ posti, scadenza }),
  ];
  if (i.callGiaFissata) {
    righe.push(
      "CALL GIA' FISSATA: a questo lead l'offerta l'hai gia' presentata e la videocall c'e'. Se ti chiede dell'offerta rispondi con i fatti qui sopra e rimanda al consulente in call, dove blocca il posto con le condizioni del Black Friday.",
    );
    return righe.join('\n');
  }
  righe.push(
    "NEL PITCH (FASE 5): il testo base resta com'e', su piu' righe. Cambia SOLO la riga della quota, che diventa queste due righe: \"Con il Black Friday la quota, che normalmente va dai 2.000 ai 4.000 euro, e' dai 1.000 ai 3.000 euro a seconda del percorso, e si puo' rateizzare.\" e \"In piu' c'e' la garanzia collocato o rimborsato, scritta nel contratto, e chi si iscrive ha in regalo un corso sull'intelligenza artificiale per la sua professione.\" La quota la dici una volta sola, in questa forma. Il regalo dell'Exclusive lo nomini solo se ti chiede dei regali o piu' avanti, mai al primo colpo. E' la quota obbligatoria prima della call: subito dopo, nello stesso messaggio, proponi la videocall come dice il manuale (PREZZI OBBLIGATORI). Il momento del pitch resta quello del manuale: l'offerta non lo anticipa e non lo ritarda.",
    "SE TI CHIEDE IL PREZZO PRIMA DEL PITCH: rispondi con la quota in questa stessa forma (Black Friday, 1.000-3.000 invece di 2.000-4.000, rateizzabile), poi torna dove eri nella qualifica.",
    "RATA: con l'offerta Black Friday non vale la regola RATA SOLO ALL'OCCORRENZA del manuale: niente \"circa 100 euro al mese\", niente cifre di rata, numero di rate o esempi tipo caffe' e cornetto. Su \"non ho soldi\" / \"costa troppo\": con il Black Friday il percorso costa meno del solito e si rateizza, e in call il consulente trova con lui la soluzione sostenibile; la call e' gratuita.",
  );
  if (posti || scadenza) {
    righe.push(`URGENZA VERA: ${[posti ? 'i posti limitati' : null, scadenza ? 'la scadenza' : null].filter(Boolean).join(' e ')} sono fatti veri e li puoi usare come leva per fissare la call nei giorni del blocco SLOT e non piu' avanti, in deroga alla regola generale su fretta e scarsita'. Restano vietati il senso di colpa e qualunque fatto che non sia scritto qui.`);
  }
  righe.push(
    "LA CALL (FASE 6): presentala come il momento in cui scegliete il percorso, vedete le condizioni della garanzia e fa l'iscrizione per bloccare il posto con il prezzo del Black Friday. Mai \"se ti convince\", \"se ti interessa\", \"eventualmente\": la chiusura si da' per scontata. Giorni, orari, Noemi, form e tag come nel manuale.",
    "VIDEO NEI TESTI DEL MANUALE: il video lo mandi dopo che ha fissato, come sempre, ed e' quello della REGOLA SUL VIDEO qui sopra; non chiedere se lavora o ha famiglia per sceglierlo. Nel messaggio di come funziona (FASE 6) la riga del video diventa: \"C'e' anche un video da guardare prima, con l'offerta del Black Friday spiegata per bene, cosi' in call si parte dal tuo caso.\" Nella CONFERMA POST-APPUNTAMENTO il passaggio 3 diventa: \"*Prima della videochiamata guarda questo video* 👉 <link della VSL>\", poi: \"Dentro c'e' l'offerta del Black Friday spiegata per bene, cosi' in call partiamo dal tuo caso. Quando riesci a vederlo, stasera o domani?\"",
  );
  return righe.join('\n');
}

const LINK_CONFERENZA_G = /https?:\/\/corso\.feniceacademy\.it\/conferenza-[A-Za-z0-9_-]*/g;
const DURATA_20 = /,?\s*dura\s+20\s+minuti/gi;

/**
 * Rete di sicurezza sul video (PO 10/11/2026, "due video creano confusione", caso
 * Luciani): dove vale la VSL, un conferenza-* scritto dal modello per abitudine del
 * manuale diventa la VSL, e la durata dei 20 minuti (che e' del video conferenza) sparisce.
 */
export function videoConferenzaInVsl(parts: readonly string[], vsl: string): { parts: string[]; sostituiti: number } {
  let sostituiti = 0;
  const out = parts.map((p) => {
    if (!LINK_CONFERENZA_G.test(p)) return p;
    LINK_CONFERENZA_G.lastIndex = 0;
    const n = (p.match(LINK_CONFERENZA_G) ?? []).length;
    sostituiti += n;
    return p.replace(LINK_CONFERENZA_G, vsl).replace(DURATA_20, '');
  });
  return { parts: out, sostituiti };
}
