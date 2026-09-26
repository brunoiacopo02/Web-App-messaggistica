/** Tinta e iniziali per l'avatar dei contatti della console. Pure, senza dipendenze da React. */

/** Tinta stabile (1..6) derivata da una chiave (nome o telefono): stesso input, stesso colore. */
export function tintaAvatar(chiave: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let h = 0;
  for (const ch of chiave) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return ((h % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

/** Iniziali (max 2 lettere) da un nome; ignora cifre/simboli/emoji ed è tollerante a spazi doppi. */
export function iniziali(nome: string | null): string {
  const parole = (nome ?? '')
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}]/gu, ''))
    .filter(Boolean);
  if (parole.length === 0) return '';
  const prima = parole[0][0];
  const ultima = parole.length > 1 ? parole[parole.length - 1][0] : '';
  return (prima + ultima).toUpperCase();
}
