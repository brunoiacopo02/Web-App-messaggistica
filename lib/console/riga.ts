/** Formattazione di una riga della lista chat: nome, orario, anteprima. Funzioni pure. */

import type { RigaLista } from './viste-db';

const FUSO = 'Europe/Rome';

/** `+39` seguito da 10 cifre → `+39 347 118 2290`; qualunque altro formato resta invariato. */
export function formattaTelefono(telefono: string): string {
  const m = /^\+39(\d{3})(\d{3})(\d{4})$/.exec(telefono.replace(/\s+/g, ''));
  return m ? `+39 ${m[1]} ${m[2]} ${m[3]}` : telefono;
}

export function nomeRiga(r: { nome: string | null; telefono: string | null }): { principale: string; secondario: string | null } {
  const nome = r.nome?.trim();
  if (nome) return { principale: nome, secondario: null };
  if (r.telefono) return { principale: formattaTelefono(r.telefono), secondario: 'Senza nome' };
  return { principale: 'Contatto sconosciuto', secondario: null };
}

const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtGiornoMese = new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, day: '2-digit', month: '2-digit' });

function partiGiorno(d: Date): { a: number; m: number; g: number } {
  const p = Object.fromEntries(fmtGiorno.formatToParts(d).map((x) => [x.type, x.value]));
  return { a: Number(p.year), m: Number(p.month), g: Number(p.day) };
}

const chiave = (x: { a: number; m: number; g: number }) => `${x.a}-${x.m}-${x.g}`;

/** Oggi (a Roma) `HH:MM`, ieri `Ieri`, prima `gg/mm`; `''` se manca o non è una data. */
export function orarioRiga(iso: string | null, now: Date): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const giorno = partiGiorno(d);
  const oggi = partiGiorno(now);
  if (chiave(giorno) === chiave(oggi)) return fmtOra.format(d);
  // "Ieri" sul calendario di Roma, non "24 ore fa": regge anche il cambio dell'ora legale.
  const ieriUtc = new Date(Date.UTC(oggi.a, oggi.m - 1, oggi.g - 1));
  const ieri = { a: ieriUtc.getUTCFullYear(), m: ieriUtc.getUTCMonth() + 1, g: ieriUtc.getUTCDate() };
  if (chiave(giorno) === chiave(ieri)) return 'Ieri';
  return fmtGiornoMese.format(d);
}

/** Anteprima su una riga: a capo e spazi multipli diventano uno spazio; `''` se vuota. */
export function prefissoAnteprima(anteprima: string | null): string {
  return (anteprima ?? '').replace(/\s+/g, ' ').trim();
}

/** Ordine della lista: ultimo messaggio più recente in cima, a parità l'id più alto (come il server). */
function piuVecchia(a: RigaLista, b: RigaLista): boolean {
  const ta = a.ultimoAt ?? '';
  const tb = b.ultimoAt ?? '';
  return ta === tb ? a.id < b.id : ta < tb;
}

/**
 * Fonde la prima pagina appena riletta con la lista già caricata, senza perdere le pagine
 * successive. La prima pagina vale per intero fin dove arriva: le chat che c'erano in quel tratto
 * e non ci sono più sono uscite dalla vista. Oltre il suo ultimo elemento resta la coda vecchia,
 * con il suo cursore. `arrivate` sono le righe nuove o con un messaggio più recente (da evidenziare).
 */
export function fondiPrimaPagina(
  vecchie: RigaLista[],
  pagina: { righe: RigaLista[]; prossimo: string | null },
  prossimoVecchio: string | null,
): { righe: RigaLista[]; prossimo: string | null; arrivate: number[] } {
  const prima = new Map(vecchie.map((r) => [r.id, r]));
  const arrivate = pagina.righe.filter((r) => prima.get(r.id)?.ultimoAt !== r.ultimoAt).map((r) => r.id);
  const ultima = pagina.righe[pagina.righe.length - 1];
  if (!pagina.prossimo || !ultima) return { righe: pagina.righe, prossimo: pagina.prossimo, arrivate };
  const ids = new Set(pagina.righe.map((r) => r.id));
  const coda = vecchie.filter((r) => !ids.has(r.id) && piuVecchia(r, ultima));
  return {
    righe: [...pagina.righe, ...coda],
    prossimo: coda.length > 0 ? prossimoVecchio : pagina.prossimo,
    arrivate,
  };
}
