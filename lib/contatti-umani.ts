// I lead che hanno chiesto di parlare con una persona, e perché.
//
// Il bot, quando riconosce la richiesta, mette la chat in `handed_off` e manda al CRM
// un `CONTATTO_UMANO` con le parole del lead. Il CRM le riceve come segnalazione, ma
// finché non ha una schermata dove vederle l'admin non può assegnarle a nessuno: le
// 43 richieste ferme al 25/08/2026 sono lì per questo. Questo modulo prepara l'elenco
// completo — chi, quando, con che parole e per che motivo — così il CRM ci si aggancia.
//
// Il motivo è una CATEGORIA a regole, non una parafrasi: le parole del lead viaggiano
// sempre insieme, e sono loro a fare fede. Un modello che riassume "vuole disdire"
// quando il lead ha scritto "posso spostare?" manderebbe un operatore alla telefonata
// sbagliata.

export type MessaggioIn = { body: string | null; created_at: string };

export const CATEGORIE = [
  'vuole_essere_chiamato',
  'chiede_una_persona',
  'aspetta_la_call',
  'disdetta_o_spostamento',
  'problema_prenotazione',
  'prezzo_o_pagamento',
  'lamentela',
  'altro',
] as const;

export type CategoriaContatto = (typeof CATEGORIE)[number];

export type Motivo = {
  /** Quando il lead l'ha chiesto (ISO), o `null` se non ha mai scritto. */
  richiestoIl: string | null;
  /** Le sue parole, su una riga sola. */
  parole: string;
  categoria: CategoriaContatto;
};

const norm = (s: string) =>
  s.replace(/\s+/g, ' ').trim();

const senzaAccenti = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Chiede espressamente di essere richiamato. */
const RICHIAMO = /\b(chiamami|chiamatemi|mi (puoi|potete|puo|può) chiamare|mi chiami|mi chiamate|se mi chiamate|richiamami|richiamatemi|una telefonata)\b/;

/** Chiede una persona: ci vuole un VERBO di richiesta accanto alla persona nominata.
 * "Forse lo ha cancellato la tua collega?" nomina una collega ma non ne chiede una. */
const PERSONA =
  /(parlare|parlarci|parlarne|parlo|sentire|passa(mi|temi)|mi pass[ia]|metter(e|mi) in contatto|contattare|farmi (parlare|sentire))[^.?!]{0,40}(operatore|operatrice|persona|collega|responsabile|consulente|qualcuno|umano|marta|noemi)/;

/** Il lead conferma che sta aspettando la videocall già fissata, o si prepara a
 *  connettersi: non chiede niente, ma finiva comunque in "altro" insieme a chi non ha
 *  detto niente — ed è proprio questo il 20% di segnalazioni che il CRM instrada al GDO
 *  invece che alle Conferme, perché non sa che il lead è già un lead fissato.
 *  Niente "chiamata" da sola: si sovrapporrebbe a chi la sta chiedendo (RICHIAMO). */
const ASPETTA_CALL =
  /\b(?:aspetto|aspettando|sto aspettando|attendo|in attesa d(?:i|ella))\b[^.?!]{0,30}\b(?:call|videocall|video ?chiamata)\b|\bci (?:sentiamo|vediamo)\b[^.?!]{0,30}\b(?:in call|video ?call|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\b/;

/** Disdetta o spostamento di una call già presa. Prefissi, non parole intere: nelle
 * chat vere è quasi sempre flesso ("annullarla", "spostarla", "l'ho disdetta"). */
const DISDETTA = /\b(annull|disdi|disdet|cancell|rimand|spost|rinvi|posticip)|non posso piu|non riesco piu/;

/** Il lead è bloccato davanti alla prenotazione. */
const PRENOTAZIONE = /\b(nessuna fascia|fascia oraria|non (funziona|va|si apre|riesco a prenotare)|link (non|rotto)|errore|non mi fa|non me lo fa)\b/;

const PREZZO = /\b(rate|rateizz|costo|costa|prezzo|pagamento|pagare|quanto viene|finanziament)/;

const LAMENTELA = /\b(imbarazzant|vergogn|truffa|truffator|scandalo|denunc|inaccettabil|presa in giro|prese in giro)/;

/** Un messaggio che dice espressamente "voglio una persona": è quello che conta. */
function eRichiestaEsplicita(testo: string): boolean {
  const t = senzaAccenti(testo);
  return RICHIAMO.test(t) || PERSONA.test(t);
}

function categoriaDi(testo: string): CategoriaContatto {
  const t = senzaAccenti(testo);
  // Le due richieste esplicite vengono prima: se il lead chiede una persona per
  // parlare del prezzo, all'operatore serve sapere che lo sta aspettando.
  if (PERSONA.test(t)) return 'chiede_una_persona';
  if (RICHIAMO.test(t)) return 'vuole_essere_chiamato';
  if (ASPETTA_CALL.test(t)) return 'aspetta_la_call';
  if (PRENOTAZIONE.test(t)) return 'problema_prenotazione';
  if (DISDETTA.test(t)) return 'disdetta_o_spostamento';
  if (LAMENTELA.test(t)) return 'lamentela';
  if (PREZZO.test(t)) return 'prezzo_o_pagamento';
  return 'altro';
}

/**
 * Il motivo della richiesta, dai messaggi in ingresso della chat (ordine qualsiasi).
 *
 * Si cerca il messaggio in cui il lead ha chiesto la persona — non l'ultimo che ha
 * scritto: nelle chat vere l'ultimo è quasi sempre un "ok" o un "grazie", e mandarlo
 * al CRM come motivo non dice niente a chi deve richiamare.
 */
export function motivoRichiesta(messaggi: MessaggioIn[]): Motivo {
  const utili = messaggi
    .filter((m) => norm(m.body ?? '') !== '')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (utili.length === 0) return { richiestoIl: null, parole: '', categoria: 'altro' };

  const espliciti = utili.filter((m) => eRichiestaEsplicita(norm(m.body ?? '')));
  const scelto = espliciti.length > 0 ? espliciti[espliciti.length - 1] : utili[utili.length - 1];
  const parole = norm(scelto.body ?? '');
  return { richiestoIl: scelto.created_at, parole, categoria: categoriaDi(parole) };
}

// --- Contratto v1.5: quello che il CRM si aspetta insieme alla richiesta ------------

/** Le categorie che il CRM riconosce. Un valore che non riconosce diventa `altro` da
 *  parte loro, mai un 400: una categoria sbagliata e' un fastidio, una richiesta persa
 *  e' un lead perso. */
export type CategoriaCrm =
  | 'richiamo' | 'prezzo' | 'programma' | 'sfiducia_bot' | 'problema_tecnico' | 'disdetta' | 'altro';

/**
 * Dalle nostre sette categorie alle loro sette. Si traduce solo dove il significato
 * coincide davvero; tutto il resto va in `altro`. Forzare una corrispondenza (una
 * lamentela letta come sfiducia nel bot, quando magari il lead protesta perche' un GDO
 * l'ha chiamato cinque volte) manderebbe chi richiama con l'idea sbagliata in testa —
 * ed e' esattamente il motivo per cui le parole del lead viaggiano sempre a fianco.
 */
export function categoriaPerCrm(c: CategoriaContatto): CategoriaCrm {
  switch (c) {
    case 'vuole_essere_chiamato': return 'richiamo';
    case 'disdetta_o_spostamento': return 'disdetta';
    case 'prezzo_o_pagamento': return 'prezzo';
    case 'problema_prenotazione': return 'problema_tecnico';
    // 'aspetta_la_call' non chiede niente di nuovo: non ha una coda loro, resta 'altro'.
    default: return 'altro';
  }
}

/** Fasce che il lead nomina esplicitamente. Prefissi larghi, niente deduzioni. */
const DISPONIBILITA: RegExp[] = [
  /\b(?:dopo|prima)\s+(?:le|l')?\s*\d{1,2}(?:[:.]\d{2})?\b/,
  /\b(?:dopo|prima)\s+(?:cena|pranzo|le\s+ferie|il\s+lavoro)\b/,
  /\b(?:di|la|al|nel|in)\s+(?:mattin[ao]|pomeriggio|serata|sera)\b/,
  /\bvers[oa]\s+le\s+\d{1,2}(?:[:.]\d{2})?\b/,
  /\btra\s+le\s+\d{1,2}\s+e\s+le\s+\d{1,2}\b/,
  /\bnei\s+(?:giorni\s+)?(?:feriali|festivi|weekend)\b/,
  /\b(?:solo|soltanto)\s+(?:di\s+)?(?:mattin[ao]|pomeriggio|sera)\b/,
];

/**
 * Quando il lead ha detto di essere raggiungibile, con le sue parole. `null` se non
 * l'ha detto: un orario dedotto manderebbe la telefonata a vuoto e sembrerebbe un dato.
 */
export function disponibilitaDalTesto(parole: string | null | undefined): string | null {
  if (!parole) return null;
  const testo = parole.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!testo) return null;
  let migliore: string | null = null;
  let dove = Number.POSITIVE_INFINITY;
  for (const re of DISPONIBILITA) {
    const m = testo.match(re);
    if (m && m.index !== undefined && m.index < dove) { dove = m.index; migliore = m[0].trim(); }
  }
  return migliore;
}
