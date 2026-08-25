// Una select PostgREST torna al massimo 1.000 righe, qualunque cosa dica `.limit()`.
//
// 25/08/2026 — il cron `lead-analysis` chiedeva `.limit(5000)` su 4.370 conversazioni
// e ne riceveva 1.000: sempre le stesse, già tutte analizzate. Risultato: 1 estrazione
// per run contro 1.600 di arretrato, e un aggregato calcolato su un quarto dei dati.
// Lo stesso taglio silenzioso c'era in /api/fenice/report e /api/fenice/segments.
// Il tetto non dà errore e non si vede: l'unico modo di accorgersene è contare.

/** Righe per richiesta. Il tetto del server è 1.000: chiedere di più non serve. */
export const PAGE_SIZE = 1000;

/** Quante righe al massimo prima di fermarsi comunque: una tabella che cresce non
 * deve far esplodere la memoria di una funzione da 300s. */
const MAX_ROWS = 50_000;

type Pagina<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Legge tutte le righe di una query paginandola.
 *
 * `build` riceve gli estremi (inclusi) da passare a `.range(from, to)` e torna la
 * query già eseguita — così il chiamante resta padrone di select, filtri e ordinamento.
 *
 * Un errore su una pagina interrompe e risale: dati a metà passerebbero per completi,
 * ed è esattamente il guasto che questo helper esiste per evitare.
 */
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<Pagina<T>>,
  opts?: { max?: number },
): Promise<T[]> {
  const max = opts?.max ?? MAX_ROWS;
  const righe: T[] = [];
  for (let from = 0; from < max; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const pagina = data ?? [];
    righe.push(...pagina);
    if (pagina.length < PAGE_SIZE) break;
  }
  return righe.length > max ? righe.slice(0, max) : righe;
}
