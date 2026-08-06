// Report A/B aperture Marta vs legacy Mario (sola lettura, nessuna scrittura DB).
//
// Uso:
//   SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY in env, poi:
//     node scripts/ab-report.mjs
//   SID confrontati (da env): FENICE_OPENING_TEMPLATE_SID (legacy-mario) +
//     OPENING_SID_C1|C2|T1|T2|J1|J2 (quelli mancanti vengono saltati con nota).
//
// Per ogni SID: conversazioni CRM (crm_lead_id not null) il cui PRIMO messaggio out
// con template e' quel SID. Metriche: invii, % consegnate (delivered/read), % con
// primo inbound entro 72h dal primo out, % APPUNTAMENTO, % DA_SCARTARE.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY richiesti in env');
const db = createClient(url, key, { auth: { persistSession: false } });

const OPENINGS = [
  { label: 'legacy-mario', env: 'FENICE_OPENING_TEMPLATE_SID', legacy: true },
  { label: 'C1', env: 'OPENING_SID_C1' },
  { label: 'C2', env: 'OPENING_SID_C2' },
  { label: 'C3', env: 'OPENING_SID_C3', dichiarata: true },
  { label: 'C4', env: 'OPENING_SID_C4', dichiarata: true },
  { label: 'T1', env: 'OPENING_SID_T1' },
  { label: 'T2', env: 'OPENING_SID_T2' },
  { label: 'T3', env: 'OPENING_SID_T3', dichiarata: true },
  { label: 'T4', env: 'OPENING_SID_T4', dichiarata: true },
  { label: 'J1', env: 'OPENING_SID_J1' },
  { label: 'J2', env: 'OPENING_SID_J2' },
  { label: 'J3', env: 'OPENING_SID_J3', dichiarata: true },
  { label: 'J4', env: 'OPENING_SID_J4', dichiarata: true },
];
const active = OPENINGS.filter((o) => process.env[o.env]);
const skipped = OPENINGS.filter((o) => !process.env[o.env]);
if (!active.length) throw new Error('Nessun SID di apertura in env (FENICE_OPENING_TEMPLATE_SID / OPENING_SID_*)');
const sidToOpening = new Map(active.map((o) => [process.env[o.env], o]));

const PAGE = 1000;
async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

// Conversazioni CRM
const convs = await fetchAll(() =>
  db.from('conversations').select('id, bot_outcome').not('crm_lead_id', 'is', null).order('id'),
);
const crmConvs = new Map(convs.map((c) => [c.id, c]));

// Messaggi out con template (ordinati: il primo per conversazione determina il gruppo)
const outs = await fetchAll(() =>
  db
    .from('messages')
    .select('conversation_id, template_sid, twilio_status, created_at')
    .eq('direction', 'out')
    .not('template_sid', 'is', null)
    .order('conversation_id')
    .order('created_at')
    .order('id'),
);

// Primo inbound per conversazione
const ins = await fetchAll(() =>
  db
    .from('messages')
    .select('conversation_id, created_at')
    .eq('direction', 'in')
    .order('conversation_id')
    .order('created_at'),
);
const firstIn = new Map();
for (const m of ins) if (!firstIn.has(m.conversation_id)) firstIn.set(m.conversation_id, m.created_at);

// Assegnazione conversazione → SID di apertura (primo out templated) + delivered
const assigned = new Map(); // convId -> { sid, firstOutAt, delivered }
for (const m of outs) {
  if (!crmConvs.has(m.conversation_id)) continue;
  let a = assigned.get(m.conversation_id);
  if (!a) {
    a = { sid: m.template_sid, firstOutAt: m.created_at, delivered: false };
    assigned.set(m.conversation_id, a);
  }
  if (m.template_sid === a.sid && (m.twilio_status === 'delivered' || m.twilio_status === 'read')) a.delivered = true;
}

function emptyStats() {
  return { n: 0, delivered: 0, replied72: 0, appuntamento: 0, scartare: 0 };
}
const bySid = new Map(active.map((o) => [process.env[o.env], emptyStats()]));
const H72 = 72 * 3600 * 1000;
for (const [convId, a] of assigned) {
  const stats = bySid.get(a.sid);
  if (!stats) continue; // primo template non e' un'apertura tracciata
  stats.n++;
  if (a.delivered) stats.delivered++;
  const inAt = firstIn.get(convId);
  if (inAt && new Date(inAt).getTime() - new Date(a.firstOutAt).getTime() <= H72) stats.replied72++;
  const outcome = crmConvs.get(convId).bot_outcome;
  if (outcome === 'APPUNTAMENTO') stats.appuntamento++;
  if (outcome === 'DA_SCARTARE') stats.scartare++;
}

const pct = (num, den) => (den ? ((100 * num) / den).toFixed(1) + '%' : '-');
function row(label, s) {
  return [label, String(s.n), pct(s.delivered, s.n), pct(s.replied72, s.n), pct(s.appuntamento, s.n), pct(s.scartare, s.n)];
}
function addInto(tot, s) {
  for (const k of Object.keys(tot)) tot[k] += s[k];
}

const rows = [['Apertura', 'Invii', 'Consegnate', 'Risposta<=72h', 'Appuntamento', 'Da scartare']];
const total = emptyStats();
const legacyTot = emptyStats();
const newTot = emptyStats();
// Il confronto che serve per l'AI Act: stessa apertura, sola presentazione diversa.
const dichiarateTot = emptyStats();
const nonDichiarateTot = emptyStats();
for (const o of active) {
  const s = bySid.get(process.env[o.env]);
  rows.push(row(o.label, s));
  addInto(total, s);
  addInto(o.legacy ? legacyTot : newTot, s);
  if (!o.legacy) addInto(o.dichiarata ? dichiarateTot : nonDichiarateTot, s);
}
rows.push(row('TOTALE', total));

const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
const fmt = (r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log(fmt(rows[0]));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows.slice(1, -1)) console.log(fmt(r));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
console.log(fmt(rows.at(-1)));

for (const o of skipped) console.log(`nota: ${o.label} saltata (${o.env} non in env)`);

console.log('\nConfronto risposta <=72h: legacy ' + pct(legacyTot.replied72, legacyTot.n) + ` (${legacyTot.replied72}/${legacyTot.n})` +
  ' vs nuove aggregate ' + pct(newTot.replied72, newTot.n) + ` (${newTot.replied72}/${newTot.n})`);
console.log('Confronto appuntamenti:   legacy ' + pct(legacyTot.appuntamento, legacyTot.n) + ` (${legacyTot.appuntamento}/${legacyTot.n})` +
  ' vs nuove aggregate ' + pct(newTot.appuntamento, newTot.n) + ` (${newTot.appuntamento}/${newTot.n})`);

console.log('\nCosto della dichiarazione IA (solo aperture Marta):');
console.log('  risposta <=72h: non dichiarate ' + pct(nonDichiarateTot.replied72, nonDichiarateTot.n) + ` (${nonDichiarateTot.replied72}/${nonDichiarateTot.n})` +
  ' vs dichiarate ' + pct(dichiarateTot.replied72, dichiarateTot.n) + ` (${dichiarateTot.replied72}/${dichiarateTot.n})`);
console.log('  appuntamenti:   non dichiarate ' + pct(nonDichiarateTot.appuntamento, nonDichiarateTot.n) + ` (${nonDichiarateTot.appuntamento}/${nonDichiarateTot.n})` +
  ' vs dichiarate ' + pct(dichiarateTot.appuntamento, dichiarateTot.n) + ` (${dichiarateTot.appuntamento}/${dichiarateTot.n})`);
