// INVIO MANUALE DEL VIDEO DI PREPARAZIONE ai lead che hanno già l'appuntamento
// fissato dai GDO. Serve finché il CRM non chiama /api/send-agenda da solo: il CRM
// esporta un CSV e noi mandiamo il video al posto loro.
//
// Erede di invio-video-recupero-spoki.mjs (recupero una-volta del 28/07), da cui
// riprende throttling, deduplica e la scelta di NON assegnare le conversazioni a
// Mario. Differenze: nuovo formato CSV del CRM, cinque varianti video invece di tre,
// numeri di telefono senza prefisso e appuntamenti senza anno.
//
// Uso:
//   node --env-file=.env.local scripts/invio-video-agenda-gdo.mjs <file.csv>            (DRY RUN)
//   node --env-file=.env.local scripts/invio-video-agenda-gdo.mjs <file.csv> --invia    (invia)
//
// CSV atteso (';' come separatore, prima riga di intestazione):
//   variante_video;nome;telefono;gdo;appuntamento
//   LAVORA + FAMIGLIA;Alina;3715796206;GDO 118;29/07 19:00
//
// Regole rispettate:
// - le varianti non riconosciute (es. "ZZ MAI TENTATA") non partono: video ignoto;
// - chi ha già ricevuto un link conferenza- da noi non lo riceve di nuovo;
// - gli appuntamenti già passati non partono (il video è di preparazione);
// - ordine per data appuntamento, prima i più imminenti;
// - throttling a ~25 invii/minuto, finestra oraria 09:00-20:30 di Roma;
// - le conversazioni NON vengono assegnate a Mario (ai_owner resta null) e NON hanno
//   crm_lead_id: i cron (sequence-touches, bot-followups) li ignorano e il bot non
//   risponde in automatico. Le risposte restano in inbox per un umano;
// - gdo_video_url/gdo_video_sent_at vengono comunque valorizzati sulla conversazione:
//   è il marcatore durevole che tiene questi lead visibili nel perimetro del
//   pannello /chat (lib/chat-perimetro.ts), pur senza ai_owner né campaign_id.
import fs from 'node:fs';
import { assertApprovedUtility } from './lib/template-guard.mjs';

const CSV = process.argv.find((a) => a.toLowerCase().endsWith('.csv'));
if (!CSV) throw new Error('manca il CSV: node ... scripts/invio-video-agenda-gdo.mjs <file.csv> [--invia]');
const LIVE = process.argv.includes('--invia');
const PER_MIN = 25;
const LIMITE = process.env.LIMITE ? Number(process.env.LIMITE) : Infinity;

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TW_SID = process.env.TWILIO_ACCOUNT_SID;
const TW_TOK = process.env.TWILIO_AUTH_TOKEN;
// Il valore letto da .env.local può arrivare con virgolette o con il \r di fine riga
// Windows: Twilio risponde 21212 ("From non valido") e non parte nulla.
const FROM_RAW = process.env.FROM_OVERRIDE || process.env.TWILIO_WHATSAPP_NUMBER_FENICE || '';
if (/SENSITIVE|^$/.test(FROM_RAW.trim())) throw new Error('mittente non configurato: passa FROM_OVERRIDE=whatsapp:+39...');
const FROM = (() => {
  const v = FROM_RAW.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  return v.startsWith('whatsapp:') ? v : `whatsapp:${v}`;
})();
if (!SUPA || !KEY || !TW_SID || !TW_TOK) throw new Error('env mancanti (supabase/twilio)');

// Varianti del CRM -> video Fenice. I link sono gli stessi di lib/gdo-agenda.ts
// (VIDEO_BY_PROFILO + BLACK_SUMMER_LINK), che resta la fonte di verità: se cambiano là,
// vanno cambiati anche qui. "OFFERTA DEL MESE" prevale sul profilo lavora/famiglia.
const VIDEO = {
  'OFFERTA DEL MESE': 'https://corso.feniceacademy.it/conferenza-black-summer',
  'LAVORA + FAMIGLIA': 'https://corso.feniceacademy.it/conferenza-dx',
  'LAVORA + NO FIGLI': 'https://corso.feniceacademy.it/conferenza-bx',
  'NON LAVORA + FAMIGLIA': 'https://corso.feniceacademy.it/conferenza-ex',
  'NON LAVORA + NO FIGLI': 'https://corso.feniceacademy.it/conferenza-axmsbn9r50',
};

// Un template UTILITY per variante, con il link fisso dentro al testo ({{1}} = nome).
// SEMPRE questi: il parametrico HX34d9a93b… ({{1}} nome, {{2}} data, {{3}} url) è
// comodo perché ne basta uno per tutte le varianti, ma Meta l'ha riclassificato
// MARKETING — pesa sul quality rating del numero e cade sotto i limiti marketing
// per-utente. Usato per sbaglio nel giro del 29/07 sera: non rifarlo.
const TEMPLATE_PER_VARIANTE = {
  'OFFERTA DEL MESE': 'HX4c41710aede255de338a88c1b9f0cac2', // fenice_video_gdo_offerta_v3
  'LAVORA + FAMIGLIA': 'HX47cd8c6248050867fed62dda2e138693', // fenice_video_gdo_lavora_famiglia_v2
  'LAVORA + NO FIGLI': 'HX1dbf9d306d986456a42a73dbd101b7c8', // fenice_video_gdo_lavora_v2
  'NON LAVORA + FAMIGLIA': 'HX9d466fa6f2e282ba47fdbf905468922b', // fenice_video_gdo_nonlavora_famiglia_v2
  'NON LAVORA + NO FIGLI': 'HX5215dc8f3bd44c26cbb291f368231f8a', // fenice_video_gdo_nonlavora_v2
};
// Via d'uscita se un template UTILITY viene sospeso da Meta e serve partire comunque:
// va deciso da un umano, caso per caso, sapendo che si spende quality rating.
const PARAMETRICO = process.env.VIDEO_PREP_TEMPLATE_SID;
if (PARAMETRICO) console.log(`ATTENZIONE: template parametrico forzato (${PARAMETRICO.slice(0, 12)}…). Se è HX34d9a93b… è MARKETING.\n`);

const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const enc = encodeURIComponent;
const sb = async (path, init) => {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...h, ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`supabase ${path.slice(0, 60)} ${r.status} ${(await r.text()).slice(0, 200)}`);
  // Prefer: return=minimal risponde 201 con corpo VUOTO: r.json() qui lancerebbe
  // "Unexpected end of JSON input" dopo che il messaggio è già partito.
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

// Il CRM manda nome e cognome in un campo solo: negli invii va solo il nome proprio.
const soloNome = (n) => {
  const t = (n ?? '').trim().split(/\s+/)[0] ?? '';
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '';
};

// Ricalca lib/phone.ts: i numeri del CRM arrivano senza prefisso ("3715796206"), ma in
// DB e su Twilio servono in E.164, altrimenti la deduplica non trova nulla e Twilio
// rifiuta il destinatario.
const toE164 = (input) => {
  let s = String(input ?? '').trim().replace(/^whatsapp:/i, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  s = s.replace(/[\s().\-]/g, '');
  if (s.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
  if (!/^\d+$/.test(s)) return null;
  s = s.replace(/^0+/, '');
  if (s.length < 9 || s.length > 12) return null;
  return `+39${s}`;
};

// "30/07 15:00" (senza anno) -> timestamp. L'anno è quello corrente, tranne quando la
// data cadrebbe nel passato remoto: allora è l'anno prossimo (a cavallo di capodanno).
const ANNO = Number(new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }).split('/')[2]);
const quando = (s) => {
  const [d, o = '00:00'] = String(s ?? '').trim().split(/\s+/);
  const [gg, mm, aaaa] = d.split('/');
  if (!gg || !mm) return NaN;
  const anno = aaaa ? Number(aaaa.length === 2 ? `20${aaaa}` : aaaa) : ANNO;
  const t = Date.parse(`${anno}-${mm.padStart(2, '0')}-${gg.padStart(2, '0')}T${o}:00+02:00`);
  if (!aaaa && t < Date.now() - 180 * 86400000) return t + 365 * 86400000;
  return t;
};
// "30/07 15:00" -> "30/07 alle 15:00"
const dataUmana = (s) => {
  const [d, o] = String(s ?? '').trim().split(/\s+/);
  const [gg, mm] = d.split('/');
  return `${gg}/${mm} alle ${o}`;
};

const oraRoma = () => {
  const p = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: 'numeric', minute: 'numeric', hour12: false })
    .formatToParts(new Date());
  const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return g('hour') * 60 + g('minute');
};

const righe = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => {
  const [variante, nome, telefono, gdo, appuntamento] = l.split(';').map((c) => (c ?? '').trim());
  return { variante, nome, telefono, gdo, appuntamento, phone: toE164(telefono) };
});

const scartati = [];
const tieni = [];
for (const r of righe) {
  if (!VIDEO[r.variante]) scartati.push({ ...r, perche: `variante non riconosciuta (${r.variante})` });
  else if (!PARAMETRICO && !TEMPLATE_PER_VARIANTE[r.variante]) scartati.push({ ...r, perche: `nessun template UTILITY per "${r.variante}"` });
  else if (!r.phone) scartati.push({ ...r, perche: `telefono non valido (${r.telefono})` });
  else if (!Number.isFinite(quando(r.appuntamento))) scartati.push({ ...r, perche: `data illeggibile (${r.appuntamento})` });
  else if (quando(r.appuntamento) < Date.now() && process.env.INCLUDI_PASSATI !== '1') scartati.push({ ...r, perche: `appuntamento già passato (${r.appuntamento})` });
  else tieni.push(r);
}
const target = tieni.sort((a, b) => quando(a.appuntamento) - quando(b.appuntamento));
console.log(`CSV: ${righe.length} righe | candidati: ${target.length} | scartati: ${scartati.length}`);
for (const s of scartati) console.log(`   escluso: ${s.nome} (${s.telefono}) ${s.gdo} ${s.appuntamento} -> ${s.perche}`);

// Chi ha già ricevuto un link video da noi non lo riceve due volte (vale anche per
// l'invio di ieri: le liste del CRM si sovrappongono).
const gia = new Set();
for (let i = 0; i < target.length; i += 25) {
  const chunk = target.slice(i, i + 25).map((r) => enc(r.phone)).join(',');
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
const finali = target.filter((r) => !gia.has(r.phone));
console.log(`già serviti da noi (saltati): ${target.length - finali.length}`);
const perVariante = finali.reduce((a, r) => ({ ...a, [r.variante]: (a[r.variante] ?? 0) + 1 }), {});
console.log(`DA INVIARE: ${finali.length} -> ${Object.entries(perVariante).map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
console.log(`${LIVE ? '*** INVIO REALE ***' : 'DRY RUN'} | mittente ...${FROM.slice(-4)} | template ${PARAMETRICO ? 'parametrico MARKETING' : 'per-variante UTILITY'}\n`);

// Finestra oraria: non si scrive a nessuno alle 3 di notte per un errore di lancio.
if (LIVE && (oraRoma() < 9 * 60 || oraRoma() >= 20 * 60 + 30) && process.env.FORZA_ORARIO !== '1') {
  throw new Error(`fuori finestra 09:00-20:30 (ora di Roma: ${Math.floor(oraRoma() / 60)}:${String(oraRoma() % 60).padStart(2, '0')}). FORZA_ORARIO=1 per forzare.`);
}

const twAuth = 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOK}`).toString('base64');

// Presidio: prima di spedire, si chiede a Meta come ha classificato DAVVERO ogni
// template che useremo. Il 29/07 il controllo non c'era e sono partiti 69 messaggi con
// un template MARKETING già scartato la mattina. Vale anche in dry run: l'errore va
// visto prima di lanciare l'invio, non dopo. Fail-closed, override per singolo SID.
const sidDaUsare = [...new Set(finali.map((r) => PARAMETRICO ?? TEMPLATE_PER_VARIANTE[r.variante]).filter(Boolean))];
for (const sid of sidDaUsare) {
  const a = await assertApprovedUtility(sid, { auth: twAuth });
  console.log(`   template ${sid.slice(0, 12)}… ${a.name ?? ''} → ${a.status} ${a.category}${a.override ? ' (override)' : ''}`);
}
console.log('');

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const esiti = { csv: CSV, inviati: 0, falliti: 0, saltati: target.length - finali.length, scartati, errori: [] };
const daFare = finali.slice(0, LIMITE);

for (const [i, r] of daFare.entries()) {
  const nome = soloNome(r.nome);
  const url = VIDEO[r.variante];
  // Nel per-variante il link e la data non sono variabili: stanno nel testo approvato.
  const sid = PARAMETRICO ?? TEMPLATE_PER_VARIANTE[r.variante];
  const vars = PARAMETRICO ? { 1: nome, 2: dataUmana(r.appuntamento), 3: url } : { 1: nome };

  if (!LIVE) {
    console.log(`[dry] ${String(i + 1).padStart(2)} ${nome.padEnd(14)} ${r.phone.padEnd(14)} ${r.appuntamento.padEnd(12)} ${r.gdo.padEnd(8)} ${r.variante.padEnd(22)} ${sid.slice(0, 12)}… ${url}`);
    continue;
  }

  try {
    const { conversationId } = await trovaOCrea(r.phone, nome);
    const body = new URLSearchParams({
      To: `whatsapp:${r.phone}`,
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
        body: `Video di preparazione (${r.variante}) ${url}`,
        twilio_sid: msg.sid, twilio_status: msg.status,
        template_sid: sid, is_template: true,
        sender: 'automazione',
      }),
      headers: { Prefer: 'return=minimal' },
    });
    // Marcatore durevole del video mandato: senza questo la conversazione resta
    // invisibile a chi la cerca dopo (es. il pannello /chat), perché non ha
    // ai_owner né campaign_id. Ricalca gdo_video_url/gdo_video_sent_at di
    // invio-agenda-gdo.mjs, ma valorizzato subito perché qui il video è già partito.
    await sb(`conversations?id=eq.${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        last_message_at: new Date().toISOString(),
        gdo_video_url: url,
        gdo_video_sent_at: new Date().toISOString(),
      }),
      headers: { Prefer: 'return=minimal' },
    });
    esiti.inviati++;
    console.log(`  ok  ${String(i + 1).padStart(2)}/${daFare.length} ${nome.padEnd(14)} ${r.phone} ${msg.status}`);
  } catch (e) {
    esiti.falliti++;
    esiti.errori.push({ nome: r.nome, telefono: r.phone, gdo: r.gdo, appuntamento: r.appuntamento, errore: String(e.message ?? e) });
    console.log(`  KO  ${String(i + 1).padStart(2)}/${daFare.length} ${nome.padEnd(14)} ${r.phone} -> ${e.message ?? e}`);
  }

  if (i < daFare.length - 1) await pausa(Math.ceil(60000 / PER_MIN));
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
  // ai_owner e crm_lead_id deliberatamente non impostati: vedi nota in testa al file.
  const nuova = await sb('conversations', {
    method: 'POST',
    body: JSON.stringify({ lead_id: leadId }),
    headers: { Prefer: 'return=representation' },
  });
  return { leadId, conversationId: nuova[0].id };
}

if (LIVE) {
  console.log(`\n=== ESITO === inviati: ${esiti.inviati} | falliti: ${esiti.falliti} | saltati (già serviti): ${esiti.saltati}`);
  if (esiti.errori.length) {
    console.log('\nnumeri andati in errore (da girare al CRM):');
    for (const e of esiti.errori) console.log(`  ${e.nome};${e.telefono};${e.gdo};${e.appuntamento};${e.errore}`);
  }
  const out = `C:/Users/bruno/Desktop/esito-invio-video-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(out, JSON.stringify(esiti, null, 2));
  console.log(`\nreport salvato in ${out}`);
}
