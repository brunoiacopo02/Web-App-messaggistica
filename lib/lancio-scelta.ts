import type { LancioSlots, LancioKind, LancioInfo } from './lancio-crm';
import { isoWithOffset } from './bot-contract';
import { romeDayKey, romeHour, romeMinute, romeOffset } from './rome-time';

// La scelta della sera del webinar (spec §5.4), senza rete e senza database: le regole
// dure, i tag, le ore proponibili e ogni testo fisso che il lead legge. Il modello non
// scrive mai un'ora: le vede qui, come stringhe ISO da copiare in un tag, e il tag torna
// qui per essere validato. Tutto si deriva da `lancio_evento_at`, niente date scritte a
// mano: la prova generale del B6 sposta l'evento e tutto il resto lo segue.

export type GiorniLancio = { evento: string; giornoDopo: string; dopodomani: string };
export type ModoPostPitch = 'notte' | 'giorno';
export type MotivoAtNonValido = 'formato' | 'giorno_non_ammesso' | 'ora_non_tonda' | 'fuori_fascia' | 'troppo_vicino';
export type ValidazioneAt =
  | { ok: true; kind: LancioKind; date: string; hour: number }
  | { ok: false; motivo: MotivoAtNonValido };
export type LancioTag = { tag: 'CHIAMA_ORA' } | { tag: 'PRENOTA'; at: string } | { tag: 'SLOTS' } | { tag: 'NO' };
export type OreProponibili = { mattina: number[]; pomeriggio: number[]; dopodomani: number[]; mattinaEsaurita: boolean };

const H = 3600_000;
/** Un'ora prenotabile deve stare almeno un'ora avanti: i venditori vanno avvisati. */
const ANTICIPO_MINIMO_MS = 1 * H;
const FASCIA_GIORNO_DOPO = { da: 9, a: 20 };
const FASCIA_DOPODOMANI = { da: 9, a: 14 };
const PRIMA_ORA_POMERIGGIO = 15;
/** Fine della notte del webinar: dopo, si risponde solo in fascia. */
const FINE_NOTTE_HHMM = '03:00';
const FASCIA_RISPOSTE = { daMin: 8 * 60 + 30, aMin: 23 * 60 };
/** Il blast parte 90' prima dell'evento: da lì il lead può chiedere assistenza. */
const ASSISTENZA_DA_MIN_PRIMA = 90;

const pad = (n: number) => String(n).padStart(2, '0');

/** Somma giorni a una chiave 'YYYY-MM-DD' con ancora UTC a mezzogiorno (immune dalla DST). */
function aggiungiGiorni(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const a = new Date(Date.UTC(y, m - 1, d, 12));
  a.setUTCDate(a.getUTCDate() + n);
  return `${a.getUTCFullYear()}-${pad(a.getUTCMonth() + 1)}-${pad(a.getUTCDate())}`;
}

export function giorniLancio(eventoAt: Date): GiorniLancio {
  const evento = romeDayKey(eventoAt);
  return { evento, giornoDopo: aggiungiGiorni(evento, 1), dopodomani: aggiungiGiorni(evento, 2) };
}

/** 'YYYY-MM-DD' + ora tonda ⇒ ISO con l'offset di Roma di QUEL giorno. */
export function atIso(date: string, hour: number): string {
  const ancora = new Date(`${date}T12:00:00Z`);
  return `${date}T${pad(hour)}:00:00${romeOffset(ancora)}`;
}

const istante = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00${romeOffset(new Date(`${date}T12:00:00Z`))}`);

/** Notte = dall'inizio dell'evento alle 03:00 del giorno dopo: il lead sta scrivendo ora. */
export function modoPostPitch(now: Date, eventoAt: Date): ModoPostPitch {
  const { giornoDopo } = giorniLancio(eventoAt);
  const ms = now.getTime();
  return ms >= eventoAt.getTime() && ms < istante(giornoDopo, FINE_NOTTE_HHMM) ? 'notte' : 'giorno';
}

const minutiDelGiorno = (d: Date) => romeHour(d) * 60 + romeMinute(d);

/**
 * Il bot può rispondere adesso? Dentro la finestra dell'evento sempre (il lead sta
 * guardando la live o ha appena premuto il pulsante); fuori, in post_pitch solo 08:30-23:00
 * di Roma — un inbound delle 04:00 lo riprende il re-drive di `bot-followups` alle 08:30.
 * In link_inviato fuori finestra non si risponde più: il 6 arriva il follow-up (B5).
 */
export function puoRispondere(now: Date, eventoAt: Date, fase: 'link_inviato' | 'post_pitch'): boolean {
  const { giornoDopo } = giorniLancio(eventoAt);
  const ms = now.getTime();
  const da = fase === 'link_inviato' ? eventoAt.getTime() - ASSISTENZA_DA_MIN_PRIMA * 60_000 : eventoAt.getTime();
  const a = fase === 'link_inviato' ? istante(giornoDopo, '00:00') : istante(giornoDopo, FINE_NOTTE_HHMM);
  if (ms >= da && ms < a) return true;
  // L'assistenza finisce col giorno dell'evento: il 6 il lead riceve il follow-up (B5) e
  // da lì risponde Mario. Un turno di assistenza il giorno dopo non esiste.
  if (fase === 'link_inviato') return false;
  const m = minutiDelGiorno(now);
  return m >= FASCIA_RISPOSTE.daMin && m < FASCIA_RISPOSTE.aMin;
}

const kindDi = (date: string, hour: number, g: GiorniLancio): LancioKind =>
  date === g.dopodomani ? 'dopodomani' : hour < PRIMA_ORA_POMERIGGIO ? 'mattina' : 'pomeriggio';

/** Le regole dure sull'ora scelta (spec §5.4). L'ordine dei motivi va dal più grave al più fine. */
export function validaAtLancio(at: string, now: Date, eventoAt: Date): ValidazioneAt {
  if (!isoWithOffset(at)) return { ok: false, motivo: 'formato' };
  const ms = Date.parse(at);
  const d = new Date(ms);
  const g = giorniLancio(eventoAt);
  const date = romeDayKey(d);
  if (date !== g.giornoDopo && date !== g.dopodomani) return { ok: false, motivo: 'giorno_non_ammesso' };
  // Roma ha sempre un offset a ore intere: minuti e secondi UTC sono quelli italiani.
  if (d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) return { ok: false, motivo: 'ora_non_tonda' };
  const hour = romeHour(d);
  const fascia = date === g.giornoDopo ? FASCIA_GIORNO_DOPO : FASCIA_DOPODOMANI;
  if (hour < fascia.da || hour > fascia.a) return { ok: false, motivo: 'fuori_fascia' };
  if (ms < now.getTime() + ANTICIPO_MINIMO_MS) return { ok: false, motivo: 'troppo_vicino' };
  return { ok: true, kind: kindDi(date, hour, g), date, hour };
}

const TAG_RE = /\[LANCIO:(CHIAMA_ORA|PRENOTA|SLOTS|NO)(?:\|([^\]]*))?\]/gi;

/** Il primo tag del lancio nel testo del modello. PRENOTA senza argomento non vale. */
export function parseLancioTag(raw: string): LancioTag | null {
  for (const m of raw.matchAll(TAG_RE)) {
    const kind = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    if (kind === 'CHIAMA_ORA') return { tag: 'CHIAMA_ORA' };
    if (kind === 'SLOTS') return { tag: 'SLOTS' };
    if (kind === 'NO') return { tag: 'NO' };
    if (kind === 'PRENOTA' && arg) return { tag: 'PRENOTA', at: arg };
  }
  return null;
}

export function stripLancioTags(raw: string): string {
  return raw.replace(TAG_RE, '').replace(/[ \t]{2,}/g, '  ').trim();
}

const oreDa = (da: number, a: number) => Array.from({ length: a - da + 1 }, (_, i) => da + i);

/**
 * Le ore che si possono proporre adesso. La mattina del giorno dopo la decide il CRM
 * (calendario dei venditori); il pomeriggio e la mattina di dopodomani vanno alle
 * Conferme e non hanno tetto (decisione 8), quindi restano proponibili anche se la
 * chiamata agli slot è fallita — il lead non deve restare senza un'ora per un timeout.
 */
export function oreProponibili(slots: LancioSlots | null, now: Date, eventoAt: Date): OreProponibili {
  const g = giorniLancio(eventoAt);
  const abbastanzaAvanti = (date: string, hour: number) => Date.parse(atIso(date, hour)) >= now.getTime() + ANTICIPO_MINIMO_MS;
  const mattinaGrezza = slots && Array.isArray(slots.mattina)
    ? slots.mattina.filter((s) => s.liberi > 0 && s.hour >= FASCIA_GIORNO_DOPO.da && s.hour < PRIMA_ORA_POMERIGGIO).map((s) => s.hour)
    : [];
  const mattina = [...new Set(mattinaGrezza)].sort((a, b) => a - b).filter((h) => abbastanzaAvanti(g.giornoDopo, h));
  const pomeriggio = oreDa(PRIMA_ORA_POMERIGGIO, FASCIA_GIORNO_DOPO.a).filter((h) => abbastanzaAvanti(g.giornoDopo, h));
  const dopodomani = oreDa(FASCIA_DOPODOMANI.da, FASCIA_DOPODOMANI.a).filter((h) => abbastanzaAvanti(g.dopodomani, h));
  return { mattina, pomeriggio, dopodomani, mattinaEsaurita: slots?.mattinaEsaurita === true || mattina.length === 0 };
}

const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

/** 'martedì 6 ottobre' da 'YYYY-MM-DD'. */
export function etichettaGiorno(date: string): string {
  return fmtGiorno.format(new Date(`${date}T12:00:00Z`));
}

const elencoOre = (ore: number[]) =>
  ore.length === 1 ? `alle ${ore[0]}` : `${ore.slice(0, -1).map((h) => `alle ${h}`).join(', ')} o alle ${ore[ore.length - 1]}`;
const fasciaOre = (ore: number[]) => (ore.length === 1 ? `alle ${ore[0]}` : `dalle ${ore[0]}` + ` alle ${ore[ore.length - 1]}`);

/** Come chiamare i due giorni a seconda di quando siamo: di notte "domani", di giorno "oggi". */
function nomiGiorni(g: GiorniLancio, modo: ModoPostPitch) {
  return modo === 'notte'
    ? { mattinaDopo: 'domattina', pomDopo: 'domani pomeriggio', giornoDopo: 'domani', dopodomani: etichettaGiorno(g.dopodomani), dopodomaniMattina: `${etichettaGiorno(g.dopodomani)} dalle 9 alle 14` }
    : { mattinaDopo: 'stamattina', pomDopo: 'oggi pomeriggio', giornoDopo: 'oggi', dopodomani: 'domani', dopodomaniMattina: 'domani mattina dalle 9 alle 14' };
}

/** Il messaggio con le ore, scritto dal codice. Di giorno la mattina del 6 non si nomina. */
export function testoSlots(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  const n = nomiGiorni(giorni, modo);
  const mattina = modo === 'notte' ? ore.mattina : [];
  const ddTesto = ore.dopodomani.length > 0 ? n.dopodomaniMattina : null;
  if (mattina.length > 0 && ore.pomeriggio.length > 0) {
    return `Per la call ho libero ${n.mattinaDopo} ${elencoOre(mattina)}, oppure ${n.pomDopo} ${fasciaOre(ore.pomeriggio)}: che ora preferisci?`;
  }
  if (ore.pomeriggio.length > 0) {
    const testa = modo === 'notte' ? 'Domattina è tutto pieno. ' : '';
    const coda = ddTesto ? ` Se puoi solo la mattina, ho ${ddTesto}.` : '';
    return `${testa}Per la call ho ${n.pomDopo} ${fasciaOre(ore.pomeriggio)}: che ora preferisci?${coda}`;
  }
  if (ddTesto) return `Per ${n.giornoDopo} non ho più ore libere. Ho ${ddTesto}: che ora preferisci?`;
  return 'Per questi due giorni non ho più ore libere: ti fa richiamare un nostro consulente, lascio nota.';
}

/** Il blocco per il system prompt: le sole stringhe che il modello può mettere nel tag. */
export function bloccoSlotPerPrompt(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  const riga = (date: string, h: number, nota: string) => `- ${atIso(date, h)} → ${etichettaGiorno(date)} alle ${h}:00 (${nota})`;
  const righe = [
    ...ore.mattina.map((h) => riga(giorni.giornoDopo, h, modo === 'notte' ? 'domattina' : 'stamattina, SOLO se la chiede il lead: non proporla tu')),
    ...ore.pomeriggio.map((h) => riga(giorni.giornoDopo, h, modo === 'notte' ? 'domani pomeriggio' : 'oggi pomeriggio')),
    ...ore.dopodomani.map((h) => riga(giorni.dopodomani, h, modo === 'notte' ? 'dopodomani mattina, solo se il lead può solo la mattina o lo chiede' : 'domani mattina')),
  ];
  return [
    'ORE PRENOTABILI (nel tag [LANCIO:PRENOTA|...] copia ESATTAMENTE una di queste stringhe ISO, nessun altro giorno o ora esiste):',
    ...(righe.length > 0 ? righe : ['- (nessuna ora libera: rispondi con [LANCIO:SLOTS] e basta)']),
    ore.mattina.length === 0 ? `Mattina di ${etichettaGiorno(giorni.giornoDopo)}: NESSUNA ora libera, non proporla.` : '',
  ].filter(Boolean).join('\n');
}

const oraLeggibile = (at: string) => {
  const d = new Date(Date.parse(at));
  return `${etichettaGiorno(romeDayKey(d))} alle ${romeHour(d)}:00`;
};

export function testoConfermaChiamata(nomeVenditore: string): string {
  return `Perfetto, ti chiama ${nomeVenditore} tra pochissimo.`;
}

export function testoConfermaPrenotazione(kind: LancioKind, at: string, nomeVenditore?: string | null): string {
  const chi = kind === 'mattina' && nomeVenditore ? `ti chiama ${nomeVenditore}` : 'ti chiama un nostro consulente';
  return `Perfetto, ci sentiamo ${oraLeggibile(at)}: ${chi}. Tieni il telefono a portata di mano.`;
}

export function testoOraEsaurita(hour: number, ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  return `Le ${hour} si sono appena riempite. ${testoSlots(ore, giorni, modo)}`;
}

export function testoAtNonValido(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  return `Quell'ora non riesco a fissarla. ${testoSlots(ore, giorni, modo)}`;
}

export const TESTO_NESSUN_VENDITORE = 'Stasera i consulenti sono tutti occupati: fissiamo domani?';
export const TESTO_CHIAMATA_FUORI_ORARIO = 'A quest\'ora fissiamo direttamente la call.';
export const TESTO_ERRORE_CRM = 'Ho un problema tecnico a registrare la scelta in questo momento: riscrivimi tra qualche minuto e la fisso subito.';
export const TESTO_DOPO_SCELTA = 'Ricevuto, lo passo al consulente che ti chiama.';
export const TESTO_CONGEDO_POST_PITCH = 'Nessun problema, grazie per aver seguito la live! Se ci ripensi, scrivimi qui.';

/** Il testo precompilato del pulsante (spec §6.3): non è una risposta del lead. */
export const MARKER_PULSANTE_RE = /live web developer ai/i;
const MAX_RISPOSTE = 6;
const MAX_LUNGHEZZA_RISPOSTA = 300;

/** Le parole del lead nel post-pitch, accumulate: sono le "info" che vanno al venditore. */
export function raccogliRisposte(info: LancioInfo | null, nuoviInbound: string[]): LancioInfo {
  const pulite = nuoviInbound
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0 && !MARKER_PULSANTE_RE.test(s))
    .map((s) => s.slice(0, MAX_LUNGHEZZA_RISPOSTA));
  return { ...(info ?? {}), risposte: [...(info?.risposte ?? []), ...pulite].slice(-MAX_RISPOSTE) };
}
