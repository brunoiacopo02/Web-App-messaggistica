import { romeDayKey, romeHour } from './rome-time';

/**
 * Quando chiama Noemi (le Conferme del CRM), in un posto solo. Dal 27/10/2026 (PO 24/10)
 * Noemi attacca alle 9 e la regola è quella della board Conferme del CRM
 * (src/lib/conferme/boardWindow.ts nel repo del CRM):
 *
 * - call dalle 15 in poi: lo stesso giorno, qualche ora prima (invariato);
 * - call del mattino (10-14) fissata il giorno lavorativo prima o lo stesso giorno: la
 *   mattina stessa, dalle 9;
 * - call del mattino fissata con più anticipo: il giorno prima, e se non risponde di nuovo
 *   la mattina stessa;
 * - call alle 9: il giorno prima, la mattina stessa non si fa in tempo; ma se è stata fissata
 *   dopo le 19 del giorno prima (o più tardi) il giorno prima non c'è più: la mattina stessa
 *   alle 9 in punto, appena attacca (PO 24/10/2026).
 *
 * Conta QUANDO è stata fissata la call, non adesso: il promemoria del giorno prima parte a
 * 24 ore dalla call, quando "domani" è vero per tutti, ma le Conferme hanno deciso in base
 * al giorno del fissaggio. Il giorno prima di un lunedì è il sabato: la domenica non si
 * lavora.
 */
export type NoemiCaso = 'pomeriggio' | 'mattina-stessa' | 'giorno-prima-poi-mattina' | 'giorno-prima' | 'nove-in-punto';

export interface PianoNoemi {
  caso: NoemiCaso;
  /** Il giorno lavorativo prima della call: dove serve il giorno prima. */
  giornoPrima: Date;
}

const NOEMI_POMERIGGIO_DALLE = 15;
const NOEMI_ATTACCA = 9;
/** Una call alle 9 fissata da quest'ora del giorno prima in poi non fa in tempo ad avere la chiamata del giorno prima. */
export const NOEMI_ULTIMA_ORA_GIORNO_PRIMA = 19;

/** Mezzogiorno UTC del giorno di Roma `key` ('YYYY-MM-DD'): lontano da ogni mezzanotte. */
const mezzogiorno = (key: string) => new Date(`${key}T12:00:00Z`);

/** Il giorno lavorativo prima di `d` (Roma): prima del lunedì c'è il sabato. */
export function giornoLavorativoPrima(d: Date): Date {
  const g = mezzogiorno(romeDayKey(d));
  g.setUTCDate(g.getUTCDate() - 1);
  if (g.getUTCDay() === 0) g.setUTCDate(g.getUTCDate() - 1);
  return g;
}

/** Il giorno lavorativo dopo `d` (Roma), come 'YYYY-MM-DD': dopo il sabato c'è il lunedì. */
function giornoLavorativoDopo(d: Date): string {
  const g = mezzogiorno(romeDayKey(d));
  g.setUTCDate(g.getUTCDate() + 1);
  if (g.getUTCDay() === 0) g.setUTCDate(g.getUTCDate() + 1);
  return g.toISOString().slice(0, 10);
}

export function pianoNoemi(call: Date, fissatoIl: Date): PianoNoemi {
  const giornoPrima = giornoLavorativoPrima(call);
  const ora = romeHour(call);
  if (ora >= NOEMI_POMERIGGIO_DALLE) return { caso: 'pomeriggio', giornoPrima };
  if (ora <= NOEMI_ATTACCA) {
    // Fissata il giorno prima dopo le 19, o in un giorno ancora successivo (il sabato per
    // il lunedì: la domenica non conta): niente chiamata del giorno prima.
    const giorniDopo = romeDayKey(fissatoIl);
    const keyPrima = romeDayKey(giornoPrima);
    const tardi =
      giorniDopo > keyPrima || (giorniDopo === keyPrima && romeHour(fissatoIl) >= NOEMI_ULTIMA_ORA_GIORNO_PRIMA);
    return { caso: tardi ? 'nove-in-punto' : 'giorno-prima', giornoPrima };
  }
  // 'YYYY-MM-DD' si confronta come stringa: l'ordine è quello del calendario.
  const conAnticipo = romeDayKey(call) > giornoLavorativoDopo(fissatoIl);
  return { caso: conAnticipo ? 'giorno-prima-poi-mattina' : 'mattina-stessa', giornoPrima };
}

/**
 * Da quando conta la call per dire quando chiama Noemi: il più recente fra l'arrivo
 * dell'agenda e l'ultima data ricevuta dal CRM (primo fissaggio o spostamento).
 * `undefined` se nessuno dei due è una data valida.
 */
export function fissatoIlDi(c: {
  gdo_agenda_at?: string | null;
  gdo_appuntamento_set_at?: string | null;
}): Date | undefined {
  const ms = [c.gdo_agenda_at, c.gdo_appuntamento_set_at]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((n) => !Number.isNaN(n));
  return ms.length ? new Date(Math.max(...ms)) : undefined;
}
