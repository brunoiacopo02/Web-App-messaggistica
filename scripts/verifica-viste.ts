/**
 * Verifica di coerenza (sola lettura, nessuna scrittura) fra `inVista` — il predicato
 * puro di ogni vista — e le query PostgREST che `contaViste` costruisce con
 * `applicaVista`. Le due strade devono contare le stesse chat: se divergono, la query
 * ha un bug che la funzione pura non ha (o viceversa).
 *
 *   bun --env-file=.env.local scripts/verifica-viste.ts
 */
import { getSupabaseAdmin } from '../lib/supabase/admin';
import { fetchAllRows } from '../lib/supabase/paginate';
import { getFeniceCampaignIds } from '../lib/campagne';
import { soloMondoFenice } from '../lib/chat-perimetro';
import { VISTE, inVista, type RigaVista } from '../lib/console/viste';
import { idsConErrori, contaViste } from '../lib/console/viste-db';

const COLONNE =
  'id, ai_owner, ai_status, ai_paused_at, bot_outcome, gdo_agenda_at, gdo_video_sent_at, ' +
  'campaign_id, lancio_slug, lancio_fase, last_inbound_at, unread_count';

const s = getSupabaseAdmin();
const now = new Date();

const fenice = await getFeniceCampaignIds(s);
const errori = await idsConErrori(s, now);
const conErrori = new Set(errori);

const righe = await fetchAllRows<RigaVista>(
  (a, b) => soloMondoFenice(s.from('conversations').select(COLONNE), fenice).range(a, b) as never,
);

const pura: Record<string, number> = {};
for (const v of VISTE) pura[v] = righe.filter((r) => inVista(r, v, { now, conErrori })).length;

const daQuery = await contaViste(s, now);

console.log(`Righe nel perimetro: ${righe.length}\n`);
console.log('vista'.padEnd(14) + 'pura'.padStart(8) + 'query'.padStart(8) + 'diff'.padStart(8));

let qualcheDifferenza = false;
for (const v of VISTE) {
  const p = pura[v];
  const q = daQuery[v] ?? 0;
  const diff = q - p;
  if (diff !== 0) qualcheDifferenza = true;
  console.log(v.padEnd(14) + String(p).padStart(8) + String(q).padStart(8) + String(diff).padStart(8));
}

if (qualcheDifferenza) {
  console.error('\nDifferenze diverse da zero: la query non conta come la funzione pura.');
  process.exit(1);
}
console.log('\nTutto a posto: 0 differenze su tutte le viste.');
