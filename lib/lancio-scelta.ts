import type { LancioKind, LancioInfo, LancioProssimi, LancioOreGiorno } from './lancio-crm';
import { isoWithOffset } from './bot-contract';
import { romeDayKey, romeHour, romeMinute, romeOffset } from './rome-time';
import { isMarkerPulsanteWebinar } from './primo-messaggio';

// La scelta della sera del webinar (spec §5.4), senza rete e senza database: le regole
// dure, i tag, le ore proponibili e ogni testo fisso che il lead legge. Il modello non
// scrive mai un'ora: le vede qui, come stringhe ISO da copiare in un tag, e il tag torna
// qui per essere validato. Tutto si deriva da `lancio_evento_at`, niente date scritte a
// mano: la prova generale del B6 sposta l'evento e tutto il resto lo segue.

export type GiorniLancio = { evento: string; giornoDopo: string; dopodomani: string };
export type ModoPostPitch = 'notte' | 'giorno';
/**
 * Come si chiamano i giorni ADESSO. Non è `modoPostPitch`: quello dice se la chiamata
 * immediata è ancora possibile (la notte del webinar), questo dice soltanto se il 6 è
 * "domani" o "oggi" e se il 7 è "dopodomani" o "oggi". Tenerli insieme faceva dire
 * "oggi pomeriggio" alle 20:40 del 5 (il pomeriggio del 6) e "domani mattina" il 7
 * (la mattina del 7, cioè stamattina).
 */
export type ModoEtichette = 'notte' | 'giorno' | 'dopodomani';
export type MotivoAtNonValido = 'formato' | 'giorno_non_ammesso' | 'ora_non_tonda' | 'fuori_fascia' | 'troppo_vicino';
export type ValidazioneAt =
  | { ok: true; kind: LancioKind; date: string; hour: number }
  | { ok: false; motivo: MotivoAtNonValido };
export type LancioTag = { tag: 'CHIAMA_ORA' } | { tag: 'PRENOTA'; at: string } | { tag: 'SLOTS' } | { tag: 'NO' } | { tag: 'CONFERMA' };

const H = 3600_000;
/** Un'ora prenotabile deve stare almeno un'ora avanti: i venditori vanno avvisati. */
const ANTICIPO_MINIMO_MS = 1 * H;
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

/**
 * La fine della notte del webinar: le 03:00 di Roma del giorno dopo, in millisecondi.
 *
 * E' il confine di `modoPostPitch` esposto come istante, perche' serve anche a chi non
 * sta facendo un turno: il cron del follow-up lo usa per capire se una chat rimasta in
 * `post_pitch` e' ferma dalla sera del pitch (e allora il follow-up ci vuole) o se il
 * lead sta ancora scrivendo dentro il flusso della scelta (e allora non si interrompe).
 */
export function fineNotteLancio(eventoAt: Date): number {
  return istante(giorniLancio(eventoAt).giornoDopo, FINE_NOTTE_HHMM);
}

/**
 * La notte del webinar e' finita (dalle 03:00 del giorno dopo l'evento in poi)? Decisione
 * PO del 25/09: i pulsanti di scelta esistono SOLO la sera della live. Da qui in poi chi
 * preme il pulsante del webinar, e chi era a meta' del dopo-pitch, passa a Mario standard
 * che fissa l'appuntamento come per qualunque lead. `lancio_evento_at` assente o
 * illeggibile = no: senza evento non c'e' nessuna notte da dichiarare finita, e si resta
 * sul comportamento di prima.
 */
export function dopoLaNotteDelLancio(now: Date, eventoAtIso: string | null | undefined): boolean {
  if (!eventoAtIso) return false;
  const t = Date.parse(eventoAtIso);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= fineNotteLancio(new Date(t));
}

/**
 * La live e' cominciata (dall'ora dell'evento in poi)? Da quel momento il pulsante del
 * webinar vale da solo, senza aspettare che qualcuno accenda `lancio_pulsante_attivo` a
 * mano (PO 30/09: la scelta "chiamata subito / videocall domani" e' il cuore della serata,
 * non puo' dipendere da un interruttore dimenticato). L'interruttore resta per accenderlo
 * PRIMA, in prova. Prima dell'evento no: la frase del pulsante contiene "live web developer
 * ai", e chi la scrive in attesa della live non deve ricevere il pitch.
 */
export function dallaLiveDelLancio(now: Date, eventoAtIso: string | null | undefined): boolean {
  if (!eventoAtIso) return false;
  const t = Date.parse(eventoAtIso);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}

/** Notte = dall'inizio dell'evento alle 03:00 del giorno dopo: il lead sta scrivendo ora. */
export function modoPostPitch(now: Date, eventoAt: Date): ModoPostPitch {
  const ms = now.getTime();
  return ms >= eventoAt.getTime() && ms < fineNotteLancio(eventoAt) ? 'notte' : 'giorno';
}

/**
 * Le etichette dei giorni si derivano dal GIORNO di Roma in cui siamo, non dalla finestra
 * della notte: il 5 (a qualunque ora, anche prima delle 21) il 6 è "domani"; il 6 è
 * "oggi"; il 7 le uniche ore rimaste sono quelle del 7, ed è "stamattina".
 * Dopo il 7 non ci sono più ore prenotabili e le etichette non compaiono in nessun testo.
 */
export function modoEtichette(now: Date, eventoAt: Date): ModoEtichette {
  const { giornoDopo } = giorniLancio(eventoAt);
  const oggi = romeDayKey(now);
  if (oggi === giornoDopo) return 'giorno';
  // Chiavi 'YYYY-MM-DD': l'ordine alfabetico è l'ordine cronologico.
  return oggi > giornoDopo ? 'dopodomani' : 'notte';
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

const FASCIA_CONFERME = { da: 9, a: 20 };
/** 'YYYY-MM-DD' è una domenica? Ancora UTC a mezzogiorno: il giorno della settimana non scivola. */
const domenica = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay() === 0;

/**
 * Le regole dure sull'ora scelta (spec §5.4). L'ordine dei motivi va dal più grave al più fine.
 *
 * Tre strade (PO 02/10): il giorno dopo la live resta com'era (9-14 `mattina` dai venditori,
 * 15-20 `pomeriggio` alle Conferme); da lì in poi, lun-sab 9-20 e SENZA data di fine, tutto
 * va alle Conferme (`conferme`). La domenica e il giorno della live non esistono.
 */
export function validaAtLancio(at: string, now: Date, eventoAt: Date): ValidazioneAt {
  if (!isoWithOffset(at)) return { ok: false, motivo: 'formato' };
  const ms = Date.parse(at);
  const d = new Date(ms);
  const g = giorniLancio(eventoAt);
  const date = romeDayKey(d);
  // Chiavi 'YYYY-MM-DD': l'ordine alfabetico è l'ordine cronologico.
  if (date < g.giornoDopo || domenica(date)) return { ok: false, motivo: 'giorno_non_ammesso' };
  // Roma ha sempre un offset a ore intere: minuti e secondi UTC sono quelli italiani.
  if (d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) return { ok: false, motivo: 'ora_non_tonda' };
  const hour = romeHour(d);
  if (hour < FASCIA_CONFERME.da || hour > FASCIA_CONFERME.a) return { ok: false, motivo: 'fuori_fascia' };
  if (ms < now.getTime() + ANTICIPO_MINIMO_MS) return { ok: false, motivo: 'troppo_vicino' };
  const kind: LancioKind = date === g.giornoDopo ? (hour < PRIMA_ORA_POMERIGGIO ? 'mattina' : 'pomeriggio') : 'conferme';
  return { ok: true, kind, date, hour };
}

const TAG_RE = /\[LANCIO:(CHIAMA_ORA|PRENOTA|SLOTS|NO|CONFERMA)(?:\|([^\]]*))?\]/gi;

/** Il primo tag del lancio nel testo del modello. PRENOTA senza argomento non vale. */
export function parseLancioTag(raw: string): LancioTag | null {
  for (const m of raw.matchAll(TAG_RE)) {
    const kind = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    if (kind === 'CHIAMA_ORA') return { tag: 'CHIAMA_ORA' };
    if (kind === 'SLOTS') return { tag: 'SLOTS' };
    if (kind === 'NO') return { tag: 'NO' };
    if (kind === 'CONFERMA') return { tag: 'CONFERMA' };
    if (kind === 'PRENOTA' && arg) return { tag: 'PRENOTA', at: arg };
  }
  return null;
}

export function stripLancioTags(raw: string): string {
  return raw.replace(TAG_RE, '').replace(/[ \t]{2,}/g, '  ').trim();
}

const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

/** 'martedì 6 ottobre' da 'YYYY-MM-DD'. */
export function etichettaGiorno(date: string): string {
  return fmtGiorno.format(new Date(`${date}T12:00:00Z`));
}

const elencoOre = (ore: number[]) =>
  ore.length === 1 ? `alle ${ore[0]}` : `${ore.slice(0, -1).map((h) => `alle ${h}`).join(', ')} o alle ${ore[ore.length - 1]}`;
const fasciaOre = (ore: number[]) => (ore.length === 1 ? `alle ${ore[0]}` : `dalle ${ore[0]}` + ` alle ${ore[ore.length - 1]}`);
const maiuscola = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const oraLeggibile = (at: string) => {
  const d = new Date(Date.parse(at));
  return `${etichettaGiorno(romeDayKey(d))} alle ${romeHour(d)}:00`;
};

export function testoConfermaChiamata(nomeVenditore: string): string {
  return `Perfetto, ti faccio chiamare subito da ${nomeVenditore}. È una chiamata breve per valutare insieme le ultime cose e fare l'iscrizione, così blocchi il tuo posto: sono limitati.`;
}

/**
 * Il giorno dopo non e' una telefonata: e' una videocall su Google Meet (PO 30/09). La
 * mattina l'invito parte subito dal calendario del venditore, all'email del lead; tutto il
 * resto (pomeriggio del 6, dal 7 in poi) passa dalle Conferme, che chiamano per confermare
 * e mandano il link (PO 02/10). Il giorno è assoluto ("giovedì 8 ottobre"), non "domani":
 * il lead rilegge il messaggio il giorno dopo.
 */
export function testoConfermaPrenotazione(kind: LancioKind, at: string, nomeVenditore?: string | null): string {
  const d = new Date(Date.parse(at));
  if (kind !== 'mattina') {
    return `Fissato per ${etichettaGiorno(romeDayKey(d))} alle ${romeHour(d)}:00. Ti chiamerà Noemi per confermare e mandarti il link della videocall: rispondile!`;
  }
  const conChi = nomeVenditore ? ` con ${nomeVenditore}` : ' con un nostro consulente';
  return `Perfetto, ci vediamo in videocall ${oraLeggibile(at)}${conChi}: il link per collegarti ti arriva per email.`;
}

/** Le ore delle tre strade: la mattina dei venditori e il primo giorno utile delle Conferme. */
export type OreTreStrade = {
  mattina: { date: string; ore: number[] } | null;
  conferme: { date: string; ore: number[] } | null;
  saltati: string[];
};

/**
 * Dal calendario del CRM alle ore da proporre. Il CRM ha già applicato i suoi filtri, ma
 * tra la lettura e il messaggio passa tempo: si rifiltra l'anticipo di un'ora, così non si
 * promette un'ora che `validaAtLancio` poi rifiuterebbe. Un giorno senza ore sparisce.
 * `null` (CRM non raggiungibile) = niente da proporre: chi chiama decide cosa dire.
 */
export function oreDaProssimi(p: LancioProssimi | null, now: Date): OreTreStrade {
  if (!p) return { mattina: null, conferme: null, saltati: [] };
  const avanti = (date: string, h: number) => Date.parse(atIso(date, h)) >= now.getTime() + ANTICIPO_MINIMO_MS;
  const giorno = (x: LancioOreGiorno | null) => {
    if (!x) return null;
    const ore = [...new Set(x.ore.filter((o) => o.liberi > 0).map((o) => o.hour))].sort((a, b) => a - b).filter((h) => avanti(x.date, h));
    return ore.length > 0 ? { date: x.date, ore } : null;
  };
  return { mattina: giorno(p.mattina), conferme: giorno(p.conferme), saltati: p.saltati };
}

/**
 * Come si chiama un giorno ADESSO: 'oggi', 'domani', altrimenti per esteso. Si deriva dal
 * giorno di Roma di `now`: dopo mezzanotte il 6 è già "oggi" e il 7 "domani".
 */
export function etichettaRelativa(date: string, now: Date): string {
  const oggi = romeDayKey(now);
  if (date === oggi) return 'oggi';
  if (date === aggiungiGiorni(oggi, 1)) return 'domani';
  return etichettaGiorno(date);
}

/** "alle 9, alle 10 o alle 11" per pochi orari, "dalle 9 alle 20" per una fascia continua. */
const oreLeggibili = (ore: number[]) =>
  ore.length > 3 && ore[ore.length - 1] - ore[0] === ore.length - 1 ? fasciaOre(ore) : elencoOre(ore);

export const TESTO_NESSUNA_ORA = 'In questi giorni siamo pieni: lascio nota e ti scriviamo appena si libera un posto.';

/**
 * Il messaggio con le ore delle tre strade, scritto dal codice. Mattina dei venditori
 * (se c'è) e giorno delle Conferme; i giorni `saltati` (senza ore) si dicono "pieni" così
 * il lead non si chiede dove sia finito il pomeriggio.
 */
export function testoOreTreStrade(o: OreTreStrade, now: Date): string {
  const parti: string[] = [];
  if (o.mattina) {
    const g = etichettaRelativa(o.mattina.date, now);
    parti.push(`${g === 'domani' ? 'domattina' : g === 'oggi' ? 'stamattina' : `${g} mattina`} ${oreLeggibili(o.mattina.ore)}`);
  }
  if (o.conferme) {
    const g = etichettaRelativa(o.conferme.date, now);
    const pom = o.conferme.ore.every((h) => h >= PRIMA_ORA_POMERIGGIO);
    parti.push(`${g}${pom && (g === 'domani' || g === 'oggi') ? ' pomeriggio' : ''} ${oreLeggibili(o.conferme.ore)}`);
  }
  if (parti.length === 0) return TESTO_NESSUNA_ORA;
  const pieni = o.saltati.length > 0
    ? `${maiuscola(o.saltati.map((d) => {
        const g = etichettaRelativa(d, now);
        return d === o.mattina?.date ? `${g} pomeriggio` : g;
      }).join(' e '))} siamo pieni. `
    : '';
  return `${pieni}Per la videocall ho ${parti.join(', oppure ')}: a che ora ci saresti?`;
}

/** Il blocco per il system prompt: le sole stringhe che il modello può mettere nel tag. */
export function bloccoOrePerPrompt(o: OreTreStrade, now: Date): string {
  const riga = (date: string, h: number, nota: string) => `- ${atIso(date, h)} → ${etichettaRelativa(date, now)} alle ${h}:00 (${nota})`;
  const righe = [
    ...(o.mattina?.ore ?? []).map((h) => riga(o.mattina!.date, h, 'videocall col venditore')),
    ...(o.conferme?.ore ?? []).map((h) => riga(o.conferme!.date, h, 'videocall, la conferma la fa Noemi')),
  ];
  return [
    'ORE PRENOTABILI (nel tag [LANCIO:PRENOTA|...] copia ESATTAMENTE una di queste stringhe ISO, nessun altro giorno o ora esiste):',
    ...(righe.length > 0 ? righe : ['- (nessuna ora libera: rispondi con [LANCIO:SLOTS] e basta)']),
  ].join('\n');
}

/** Quante domande di prequalifica per strada prima di proporre l'ora o la chiamata. */
export const DOMANDE_PER_PERCORSO = { chiamata: 2, mattina: 3, conferme: 3 } as const;
/** Formule che svalutano la scelta: il lead non deve mai sentirle (PO 02/10). */
export const FRASI_VIETATE = [/se ti convince/i, /se ti interessa/i, /eventualmente/i];
export const TESTO_INTRO_PREQUALIFICA =
  'Visto che i posti sono limitati, prima della videocall ti faccio un paio di domande per capire se il percorso è in linea con te.';

/** L'ora scelta e' stata presa mentre il lead rispondeva: le ore aggiornate, dal 409. */
export function testoOraEsaurita(hour: number, o: OreTreStrade, now: Date): string {
  return `Le ${hour} si sono appena riempite. ${testoOreTreStrade(o, now)}`;
}

/** L'ora del tag non passa le regole dure (o il CRM la rifiuta con 422): le ore vere. */
export function testoAtNonValido(o: OreTreStrade, now: Date): string {
  return `Quell'ora non riesco a fissarla. ${testoOreTreStrade(o, now)}`;
}

export const TESTO_NESSUN_VENDITORE = 'Stasera i consulenti sono tutti occupati: fissiamo una videocall domani?';
export const TESTO_CHIAMATA_FUORI_ORARIO = 'A quest\'ora fissiamo direttamente la videocall.';
export const TESTO_ERRORE_CRM = 'Ho un problema tecnico a registrare la scelta in questo momento: riscrivimi tra qualche minuto e la fisso subito.';
export const TESTO_DOPO_SCELTA = 'Ricevuto, lo passo al consulente che ti chiama.';
export const TESTO_CONGEDO_POST_PITCH = 'Nessun problema, grazie per aver seguito la live! Se ci ripensi, scrivimi qui.';

/** Prequalifica: la scelta, l'ora e fino a 3 domande, ognuna con la sua risposta. */
export const MAX_RISPOSTE = 12;
const MAX_LUNGHEZZA_RISPOSTA = 300;

/** Le parole del lead nel post-pitch, accumulate: sono le "info" che vanno al venditore. */
export function raccogliRisposte(info: LancioInfo | null, nuoviInbound: string[]): LancioInfo {
  const pulite = nuoviInbound
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0 && !isMarkerPulsanteWebinar(s))
    .map((s) => s.slice(0, MAX_LUNGHEZZA_RISPOSTA));
  return { ...(info ?? {}), risposte: [...(info?.risposte ?? []), ...pulite].slice(-MAX_RISPOSTE) };
}
