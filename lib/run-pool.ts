/**
 * Esegue `worker` su ogni elemento con al massimo `concurrency` esecuzioni in volo.
 * I risultati tornano nell'ordine degli input. Nato in `send-batch` (13/07/2026) per il
 * blast delle campagne; il blast del link Zoom (lancio) usa lo stesso motore.
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
