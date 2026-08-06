import Anthropic from '@anthropic-ai/sdk';
import { buildMarioSystem } from './mario-prompt';
import { romeNowContext } from './rome-time';
import { bookingSlotsContext } from './booking-slots';
import { sanitizeOutbound } from './outbound-sanitize';
import { isoWithOffset } from './bot-contract';

export const MARIO_MODEL = 'claude-sonnet-4-6';

export type MarioTurn = { role: 'user' | 'assistant'; content: string };
export type MarioOutcome = 'APPUNTAMENTO' | 'RICHIAMO' | 'DA_SCARTARE' | 'INTERROTTO';
export type MarioResult = {
  visibleReply: string;
  appointmentFixed: boolean;
  passToHuman: boolean;
  videoWatched: boolean;
  outcome?: MarioOutcome;
  scheduledAt?: string;
  discardReason?: string;
  note?: string;
};

const ESITO_RE = /\[ESITO:(APPUNTAMENTO|RICHIAMO|SCARTO|INTERROTTO)\|([^\]]*)\]/i;

/** Rileva tag speciali, li rimuove dal testo visibile e ritorna flag + esito strutturato. */
export function parseMarioReply(raw: string): MarioResult {
  const legacyAppointment = raw.includes('[APPUNTAMENTO_FISSATO]');
  const passToHuman = raw.includes('[PASSAGGIO_UMANO]');
  const videoWatched = raw.includes('[VIDEO_VISTO]');

  let outcome: MarioOutcome | undefined;
  let scheduledAt: string | undefined;
  let discardReason: string | undefined;
  let note: string | undefined;

  const m = raw.match(ESITO_RE);
  if (m) {
    const kind = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    if (kind === 'APPUNTAMENTO') { outcome = 'APPUNTAMENTO'; scheduledAt = arg || undefined; }
    else if (kind === 'RICHIAMO') {
      outcome = 'RICHIAMO';
      // Il modello può mettere qui una data SOLO se gliel'ha detta il lead; quando il
      // lead dice "a settembre" mette le sue parole. Un argomento che non è una data
      // ISO con fuso NON diventa un istante: sarebbe un'ora inventata, ed è esattamente
      // quello che per mesi è finito in agenda ai commerciali (22 richiami su 26 su
      // un'ora tonda che nessuno aveva detto).
      if (arg && isoWithOffset(arg)) scheduledAt = arg;
      else note = arg || undefined;
    }
    else if (kind === 'SCARTO') { outcome = 'DA_SCARTARE'; discardReason = arg || undefined; }
    else if (kind === 'INTERROTTO') { outcome = 'INTERROTTO'; note = arg || undefined; }
  }

  const visibleReply = sanitizeOutbound(
    raw
      .replace(ESITO_RE, '')
      .replace(/\[APPUNTAMENTO_FISSATO\]/g, '')
      .replace(/\[PASSAGGIO_UMANO\]/g, '')
      .replace(/\[VIDEO_VISTO\]/g, '')
      .trim(),
  );

  return {
    visibleReply,
    appointmentFixed: legacyAppointment || outcome === 'APPUNTAMENTO',
    passToHuman,
    videoWatched,
    outcome,
    scheduledAt,
    discardReason,
    note,
  };
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey, maxRetries: 5, timeout: 60_000 });
  return _client;
}

/**
 * Contesto per i lead arruolati per conto di un GDO: l'appuntamento l'ha già preso il
 * commerciale al telefono e il video è già partito, quindi il bot non deve ripartire
 * col pitch. La sezione del prompt che descrive già questo comportamento è
 * "SE L'APPUNTAMENTO È GIÀ FISSATO": qui la si attiva, non la si riscrive.
 */
export const GDO_CONTEXT_NOTE =
  "CONTESTO DI QUESTA CONVERSAZIONE: l'appuntamento di questo lead è GIÀ FISSATO — l'ha preso " +
  'un tuo collega al telefono, e tu gli hai già mandato il link per scegliere giorno e ora e il ' +
  "video da vedere prima della call. Applica la sezione \"SE L'APPUNTAMENTO È GIÀ FISSATO\": non " +
  'ripartire col pitch, non riproporre la call e non rimandare il video. Il collega non si nomina mai.';

/** Cosa vede Mario al posto di un messaggio del lead senza testo. Le note vocali arrivano
 *  già trascritte, quindi qui resta il materiale visivo e i documenti. */
const MEDIA_SENZA_TESTO =
  '[il lead ha inviato un contenuto senza testo: una foto, uno sticker, un video o un documento]';

/** Genera la prossima risposta del bot data la cronologia. Inietta l'ora di Roma.
 *  `personaName` (default 'Mario') parametrizza SOLO il nome nel system prompt.
 *  `contextNote` aggiunge in coda al system un contesto specifico della conversazione. */
export async function generateMarioReply(
  history: MarioTurn[],
  opts?: { now?: Date; personaName?: string; contextNote?: string },
): Promise<MarioResult> {
  // Un media senza didascalia (foto, sticker, documento) entra in `messages` con body
  // vuoto: l'API rifiuta l'intera richiesta con 400 "user messages must have non-empty
  // content", e siccome il messaggio resta nello storico quella chat non riceve più una
  // risposta, a nessun tentativo. Si sistema qui, al confine con Claude, così vale per
  // tutti i chiamanti.
  //
  // Il turno del lead NON si può scartare: il vuoto è quasi sempre l'ultimo messaggio
  // della chat, e togliendolo la conversazione finirebbe su un turno assistant — che
  // Sonnet 4.6 rifiuta a sua volta, con 400 "does not support assistant message prefill".
  // Si dice a Mario cosa è arrivato, così risponde al lead invece di ignorarlo.
  const turni = history.flatMap((t) => {
    if (typeof t.content === 'string' && t.content.trim() !== '') return [t];
    if (t.role === 'user') return [{ role: 'user' as const, content: MEDIA_SENZA_TESTO }];
    return []; // un turno di Mario senza testo non ha nulla da dire: via.
  });
  const messages =
    turni.length > 0
      ? turni
      : [{ role: 'user' as const, content: 'Inizia la conversazione presentandoti.' }];

  const now = opts?.now ?? new Date();
  const contextNote = opts?.contextNote ? `\n\n${opts.contextNote}` : '';
  const system = `${buildMarioSystem(opts?.personaName ?? 'Mario')}\n\n${romeNowContext(now)}\n\n${bookingSlotsContext(now)}${contextNote}`;

  const response = await getClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system,
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseMarioReply(raw);
}
