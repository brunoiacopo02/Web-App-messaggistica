// Agende rimaste in "inviato" ma in realta' consegnate: allinea il nostro esito e
// avvisa il CRM, cosi' il loro reinvio si sblocca.
//
// L'avviso di consegna non e' mai partito perche' CRM_AGENDA_DELIVERED_URL non era
// configurata (vedi DEFAULT_CRM_AGENDA_DELIVERED_URL in lib/send-agenda-gdo.ts). Le
// status callback di Twilio pero' sono passate: lo stato vero e' su
// messages.twilio_status, ed e' da li' che si recupera l'arretrato.
//
// Uso: node --env-file=.env.local scripts/agende-consegnate-arretrate.mjs [--esegui]

const ESEGUI = process.argv.includes('--esegui');
const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEGRETO = process.env.BOT_WEBHOOK_SECRET;
const SID_AGENDA = process.env.AGENDA_GDO_TEMPLATE_SID;
const URL_CRM = process.env.CRM_AGENDA_DELIVERED_URL || 'https://crm-sales-fenice.vercel.app/api/bot/agenda-delivery';
if (!URL_BASE || !KEY) throw new Error('env supabase mancanti');
if (!SID_AGENDA) throw new Error('AGENDA_GDO_TEMPLATE_SID mancante');
if (ESEGUI && !SEGRETO) throw new Error('BOT_WEBHOOK_SECRET mancante: serve per firmare gli avvisi');

const { createHmac } = await import('node:crypto');
// Stesso formato di lib/bot-hmac.ts: sha256=<hex>
const firma = (b) => `sha256=${createHmac('sha256', SEGRETO).update(b).digest('hex')}`;

const q = async (p) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${p}: ${await r.text()}`);
  return r.json();
};
const patch = async (p, body) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${r.status}: ${await r.text()}`);
};

// Il set da recuperare NON e' "le agende ancora inviato da noi": handleGdoDeliveryUpdate
// aggiorna la nostra colonna PRIMA di provare ad avvisare, quindi da noi risultano
// consegnate mentre il CRM le ha ancora come "inviato". Le vere sono quelle che hanno
// fatto la transizione inviato -> consegnato senza che l'avviso partisse, piu' quelle
// ancora "inviato" il cui messaggio d'agenda risulta comunque recapitato.
const tardive = await q('event_log?select=payload&type=eq.gdo_agenda_consegna_tardiva&order=created_at.asc&limit=5000');
const idTardive = [...new Set(tardive.map((e) => e.payload?.conversationId).filter((x) => x != null))];
const ancoraInviate = await q('conversations?select=id&gdo_agenda_esito=eq.inviato&crm_lead_id=not.is.null&limit=1000');
const ids = [...new Set([...idTardive, ...ancoraInviate.map((c) => c.id)])];

const convs = [];
for (let i = 0; i < ids.length; i += 80) {
  convs.push(...(await q(`conversations?select=id,crm_lead_id,gdo_agenda_esito&id=in.(${ids.slice(i, i + 80).join(',')})&crm_lead_id=not.is.null`)));
}
console.log(`da riavvisare: ${convs.length} (${idTardive.length} consegne tardive + ${ancoraInviate.length} ancora "inviato")\n`);

let consegnate = 0;
let avvisate = 0;
let fallite = 0;

for (const c of convs) {
  const m = await q(`messages?select=twilio_sid,twilio_status&conversation_id=eq.${c.id}&template_sid=eq.${SID_AGENDA}&order=created_at.desc&limit=1`);
  const riga = m[0];
  if (!riga || !['delivered', 'read'].includes(riga.twilio_status)) continue;
  consegnate++;
  console.log(`conv ${String(c.id).padEnd(5)} lead ${c.crm_lead_id}  ${riga.twilio_status}  ${riga.twilio_sid}`);
  if (!ESEGUI) continue;

  const body = JSON.stringify({ leadId: c.crm_lead_id, esito: 'consegnato', sid: riga.twilio_sid, at: new Date().toISOString() });
  const r = await fetch(URL_CRM, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-signature': firma(body) },
    body,
  });
  const testo = await r.text();
  console.log(`      -> CRM ${r.status} ${testo.slice(0, 120)}`);
  if (r.ok) {
    // Il nostro esito si allinea solo se il CRM ha davvero preso l'avviso: altrimenti
    // perderemmo la possibilita' di riprovare.
    await patch(`conversations?id=eq.${c.id}`, { gdo_agenda_esito: 'consegnato' });
    avvisate++;
  } else {
    fallite++;
  }
}

console.log(`\nconsegnate davvero (Twilio delivered/read): ${consegnate} su ${convs.length}`);
if (ESEGUI) console.log(`avvisi accettati dal CRM: ${avvisate}  falliti: ${fallite}`);
else console.log('(prova a vuoto: rilancia con --esegui)');
