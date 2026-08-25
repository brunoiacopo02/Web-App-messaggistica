// Rimette in coda le analisi che erano fallite ed erano state salvate come buone.
//
// Fino al 24/08/2026 un'estrazione non parsabile veniva scritta a database come
// "non chiaro" + "altro" + nota vuota, con ai_insight_at valorizzato: quelle righe non
// venivano mai piu' riprovate. Sono 741. Azzerando ai_insight_at tornano in coda, e
// siccome le mai analizzate hanno la precedenza non rubano il posto alle nuove.
//
// Uso: node --env-file=.env.local scripts/rianalizza-fallite.mjs [--esegui]
// Senza --esegui e' una prova a vuoto: conta e basta.
import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ESEGUI = process.argv.includes('--esegui');

const filtro = (q) => q.eq('ai_owner', 'mario')
  .not('ai_insight_at', 'is', null)
  .eq('ai_dropoff_stage', 'non chiaro')
  .eq('ai_objection_category', 'altro')
  .or('ai_objection_note.is.null,ai_objection_note.eq.');

const { count } = await filtro(db.from('conversations').select('id', { count: 'exact', head: true }));
console.log(`righe da rimettere in coda: ${count}`);
if (!ESEGUI) { console.log('(prova a vuoto: rilancia con --esegui)'); process.exit(0); }

let fatte = 0;
for (;;) {
  const { data } = await filtro(db.from('conversations').select('id')).limit(500);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length === 0) break;
  const { error } = await db.from('conversations')
    .update({ ai_insight_at: null, ai_dropoff_stage: null, ai_objection_category: null })
    .in('id', ids);
  if (error) throw new Error(error.message);
  fatte += ids.length;
  console.log(`  ${fatte}/${count}`);
}
const { count: rimaste } = await filtro(db.from('conversations').select('id', { count: 'exact', head: true }));
console.log(`fatte: ${fatte} | rimaste col vecchio fallback: ${rimaste}`);
import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ESEGUI = process.argv.includes('--esegui');

const filtro = (q) => q.eq('ai_owner', 'mario')
  .not('ai_insight_at', 'is', null)
  .eq('ai_dropoff_stage', 'non chiaro')
  .eq('ai_objection_category', 'altro')
  .or('ai_objection_note.is.null,ai_objection_note.eq.');

const { count } = await filtro(db.from('conversations').select('id', { count: 'exact', head: true }));
console.log(`righe da rimettere in coda: ${count}`);
if (!ESEGUI) { console.log('(prova a vuoto: rilancia con --esegui)'); process.exit(0); }

let fatte = 0;
for (;;) {
  const { data } = await filtro(db.from('conversations').select('id')).limit(500);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length === 0) break;
  const { error } = await db.from('conversations')
    .update({ ai_insight_at: null, ai_dropoff_stage: null, ai_objection_category: null })
    .in('id', ids);
  if (error) throw new Error(error.message);
  fatte += ids.length;
  console.log(`  ${fatte}/${count}`);
}
const { count: rimaste } = await filtro(db.from('conversations').select('id', { count: 'exact', head: true }));
console.log(`fatte: ${fatte} | rimaste col vecchio fallback: ${rimaste}`);
