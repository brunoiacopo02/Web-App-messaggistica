// INVIO DI RECUPERO (28/07/2026): Spoki non ha spedito nulla e 76 lead con
// appuntamento il 29 e 30/07 non hanno ricevuto il video di preparazione.
// Manda il video al posto loro, leggendo il CSV fornito dal CRM.
//
// Uso:
//   node --env-file=.env.local scripts/invio-video-recupero-spoki.mjs            (DRY RUN)
//   node --env-file=.env.local scripts/invio-video-recupero-spoki.mjs --invia    (invia davvero)
//
// Regole rispettate:
// - i lead marcati DA-VERIFICARE non partono (slug video sconosciuto);
// - chi ha già ricevuto un link conferenza- da noi non lo riceve di nuovo;
// - ordine per data appuntamento, prima il 29/07;
// - throttling a ~25 invii/minuto;
// - le conversazioni NON vengono assegnate a Mario (ai_owner resta null), altrimenti
//   il bot ripartirebbe col pitch con gente che ha già l'appuntamento fissato. Le
//   risposte restano in inbox per un umano.
import fs from 'node:fs';

const CSV = process.argv.find((a) => a.endsWith('.csv')) ?? 'C:/Users/bruno/Desktop/invio-video-29-30-luglio.csv';
const LIVE = process.argv.includes('--invia');
const PER_MIN = 25;

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TW_SID = process.env.TWILIO_ACCOUNT_SID;
const TW_TOK = process.env.TWILIO_AUTH_TOKEN;
// Il valore letto da .env.local può arrivare con virgolette o con il \r di fine riga
// Windows: Twilio risponde 21212 ("From non valido") e non parte nulla.
// In .env.local TWILIO_WHATSAPP_NUMBER_FENICE è un segnaposto ("[SENSITIVE]"): il
// valore vero vive solo su Vercel. FROM_OVERRIDE permette di passarlo a mano.
const FROM_RAW = process.env.FROM_OVERRIDE || process.env.TWILIO_WHATSAPP_NUMBER_FENICE || '';
if (/SENSITIVE|^$/.test(FROM_RAW.trim())) throw new Error('mittente non configurato: passa FROM_OVERRIDE=whatsapp:+39...');
const FROM = (() => {
  const v = FROM_RAW.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  return v.startsWith('whatsapp:') ? v : `whatsapp:${v}`;
})();
if (!SUPA || !KEY || !TW_SID || !TW_TOK || !FROM_RAW) throw new Error('env mancanti (supabase/twilio/from)');
// Quante ne mandi al massimo in questo giro (per un invio di prova prima del blocco).
const LIMITE = process.env.LIMITE ? Number(process.env.LIMITE) : Infinity;

// Mappa slug del CRM -> video Fenice. DA CONFERMARE col CRM prima dell'invio reale.
const VIDEO = {
  'lavora-famiglia': 'https://corso.feniceacademy.it/conferenza-dx',
  'lavora-nofigli': 'https://corso.feniceacademy.it/conferenza-bx',
  'offerta-mese': 'https://corso.feniceacademy.it/conferenza-black-summer',
};

// Template parametrico ({{1}} nome, {{2}} data, {{3}} url). Se Meta lo rifiuta perché
// l'URL sta in una variabile, si passa ai template per-slug con il link fisso.
const TEMPLATE_PARAMETRICO = process.env.VIDEO_PREP_TEMPLATE_SID ?? 'HX34d9a93bf8d2a8d91382c644106f6699';
const TEMPLATE_PER_SLUG = {
  'lavora-nofigli': 'HX1dbf9d306d986456a42a73dbd101b7c8',
  'lavora-famiglia': 'HX47cd8c6248050867fed62dda2e138693',
  // Due copie identiche in coda da Meta (v2 impantanata, v3 di riserva): SID_OFFERTA
  // permette di usare quella che viene approvata per prima.
  'offerta-mese': process.env.SID_OFFERTA ?? 'HX5937707e177b4272fba2aed3e8393cee',
};
// 'parametrico' = un template solo, con il link passato come variabile (permette anche
// il suffisso ?l=<leadId> per il tracking). 'per-slug' = tre template con link fisso.
const MODO = process.env.MODO_INVIO ?? 'parametrico';
// Suffisso di tracking per-lead richiesto dal CRM. Solo in modo parametrico.
const TRACKING = process.env.TRACKING_LEAD === '1';

const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const enc = encodeURIComponent;
const sb = async (path, init) => {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...h, ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`supabase ${path.slice(0, 60)} ${r.status} ${(await r.text()).slice(0, 200)}`);
  // Prefer: return=minimal risponde 201 con corpo VUOTO: r.json() qui lancerebbe
  // "Unexpected end of JSON input" dopo che il messaggio è già partito, facendo
  // contare come fallito un invio riuscito (e sparire la riga dal DB).
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

// Il CRM manda nome e cognome in un campo solo: negli invii va solo il nome proprio.
const soloNome = (n) => {
  const t = (n ?? '').trim().split(/\s+/)[0] ?? '';
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '';
};
// "29/07/2026 15:00" -> "29/07 alle 15:00"
const dataUmana = (s) => {
  const [d, o] = s.trim().split(/\s+/);
  const [gg, mm] = d.split('/');
  return `${gg}/${mm} alle ${o}`;
};
const quando = (s) => {
  const [d, o] = s.trim().split(/\s+/);
  const [gg, mm, aaaa] = d.split('/');
  return Date.parse(`${aaaa}-${mm}-${gg}T${o}:00+02:00`);
};

const righe = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map((l) => {
  const [leadId, nome, telefono, appuntamento, slug] = l.split(';');
  return { leadId, nome, telefono, appuntamento, slug };
});

const daVerificare = righe.filter((r) => !VIDEO[r.slug]);
const target = righe.filter((r) => VIDEO[r.slug]).sort((a, b) => quando(a.appuntamento) - quando(b.appuntamento));
console.log(`CSV: ${righe.length} righe | inviabili: ${target.length} | DA-VERIFICARE esclusi: ${daVerificare.length}`);
for (const r of daVerificare) console.log(`   escluso: ${r.nome} (${r.telefono}) ${r.appuntamento}`);

// Chi ha già ricevuto un link video da noi non lo riceve due volte.
const gia = new Set();
for (let i = 0; i < target.length; i += 25) {
  const chunk = target.slice(i, i + 25).map((r) => enc(r.telefono)).join(',');
  const leads = await sb(`leads?select=id,phone_e164&phone_e164=in.(${chunk})`);
  if (!leads.length) continue;
  const convs = await sb(`conversations?select=id,lead_id&lead_id=in.(${leads.map((l) => l.id).join(',')})`);
  if (!convs.length) continue;
  const msgs = await sb(`messages?select=conversation_id&conversation_id=in.(${convs.map((c) => c.id).join(',')})&direction=eq.out&body=ilike.${enc('*conferenza-*')}`);
  const convHa = new Set(msgs.map((m) => m.conversation_id));
  for (const c of convs) {
    if (!convHa.has(c.id)) continue;
    const lead = leads.find((l) => l.id === c.lead_id);
    if (lead) gia.add(lead.phone_e164);
  }
}
// Permette di mandare solo gli slug il cui template è già approvato, così il resto
// parte in un secondo giro senza rifare i conti.
const SOLO_SLUG = process.env.SOLO_SLUG ? process.env.SOLO_SLUG.split(',').map((s) => s.trim()) : null;
const nonServiti = target.filter((r) => !gia.has(r.telefono));
const finali = nonServiti.filter((r) => !SOLO_SLUG || SOLO_SLUG.includes(r.slug));
if (SOLO_SLUG) console.log(`filtro slug attivo: ${SOLO_SLUG.join(', ')} (esclusi ${nonServiti.length - finali.length} di altri slug)`);
console.log(`già serviti da noi (saltati): ${target.length - nonServiti.length}`);
console.log(`DA INVIARE: ${finali.length} | modo=${MODO} | tracking=${TRACKING ? 'si' : 'no'} | ${LIVE ? '*** INVIO REALE ***' : 'DRY RUN'}\n`);

const twAuth = 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOK}`).toString('base64');
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const esiti = { inviati: 0, falliti: 0, errori: [] };

console.log(`mittente: ...${FROM.slice(-4)} (lunghezza ${FROM.length})`);
for (const [i, r] of finali.slice(0, LIMITE).entries()) {
  const nome = soloNome(r.nome);
  let url = VIDEO[r.slug];
  if (TRACKING && MODO === 'parametrico') url += `?l=${r.leadId}`;
  const sid = MODO === 'parametrico' ? TEMPLATE_PARAMETRICO : TEMPLATE_PER_SLUG[r.slug];
  const vars = MODO === 'parametrico'
    ? { 1: nome, 2: dataUmana(r.appuntamento), 3: url }
    : { 1: nome };

  if (!LIVE) {
    console.log(`[dry] ${String(i + 1).padStart(2)} ${nome.padEnd(14)} ${r.telefono} ${r.appuntamento} ${r.slug.padEnd(15)} ${sid.slice(0, 12)}… ${MODO === 'parametrico' ? url : '(link nel template)'}`);
    continue;
  }

  try {
    const { conversationId } = await trovaOCrea(r.telefono, nome);
    const body = new URLSearchParams({
      To: `whatsapp:${r.telefono}`,
      From: FROM,
      ContentSid: sid,
      ContentVariables: JSON.stringify(vars),
    });
    const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: twAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const msg = await tw.json();
    if (!tw.ok) throw new Error(`${msg.code ?? tw.status}: ${msg.message ?? 'errore twilio'}`);

    await sb('messages', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: conversationId, direction: 'out',
        body: `Video di preparazione (${r.slug}) ${url}`,
        twilio_sid: msg.sid, twilio_status: msg.status,
        template_sid: sid, is_template: true,
      }),
      headers: { Prefer: 'return=minimal' },
    });
    await sb(`conversations?id=eq.${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_message_at: new Date().toISOString() }),
      headers: { Prefer: 'return=minimal' },
    });
    esiti.inviati++;
    console.log(`  ok  ${String(i + 1).padStart(2)}/${finali.length} ${nome.padEnd(14)} ${r.telefono} ${msg.status}`);
  } catch (e) {
    esiti.falliti++;
    esiti.errori.push({ nome: r.nome, telefono: r.telefono, appuntamento: r.appuntamento, errore: String(e.message ?? e) });
    console.log(`  KO  ${String(i + 1).padStart(2)}/${finali.length} ${nome.padEnd(14)} ${r.telefono} -> ${e.message ?? e}`);
  }

  if (i < finali.length - 1) await pausa(Math.ceil(60000 / PER_MIN));
}

async function trovaOCrea(phone, firstName) {
  const up = await sb('leads?on_conflict=phone_e164', {
    method: 'POST',
    body: JSON.stringify({ phone_e164: phone, first_name: firstName }),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  const leadId = up[0].id;
  const esiste = await sb(`conversations?select=id&lead_id=eq.${leadId}&limit=1`);
  if (esiste.length) return { leadId, conversationId: esiste[0].id };
  // ai_owner deliberatamente non impostato: vedi nota in testa al file.
  const nuova = await sb('conversations', {
    method: 'POST',
    body: JSON.stringify({ lead_id: leadId }),
    headers: { Prefer: 'return=representation' },
  });
  return { leadId, conversationId: nuova[0].id };
}

if (LIVE) {
  console.log(`\n=== ESITO === inviati: ${esiti.inviati} | falliti: ${esiti.falliti}`);
  if (esiti.errori.length) {
    console.log('\nnumeri andati in errore (da girare al CRM):');
    for (const e of esiti.errori) console.log(`  ${e.nome};${e.telefono};${e.appuntamento};${e.errore}`);
  }
  fs.writeFileSync('C:/Users/bruno/Desktop/esito-invio-video.json', JSON.stringify(esiti, null, 2));
  console.log('\nreport salvato in C:/Users/bruno/Desktop/esito-invio-video.json');
}
