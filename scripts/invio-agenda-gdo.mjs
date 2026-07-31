// INVIO MANUALE DELL'AGENDA ai lead fissati dai GDO, dal CSV che esporta il CRM.
// Un giro alla volta, finché il CRM non chiama /api/send-agenda da solo.
//
// Fa esattamente ciò che fa `enrollGdoLeadAsPostino` (lib/fenice-enroll.ts) per ogni
// riga del CSV: manda il template agenda col link di prenotazione e prepara la
// conversazione in modalità postino, così alla prima risposta del lead parte il video.
// Fratello di invio-video-agenda-gdo.mjs, che invece manda il video e basta.
//
// Uso:
//   node --env-file=.env.local scripts/invio-agenda-gdo.mjs <file.csv>            (DRY RUN)
//   node --env-file=.env.local scripts/invio-agenda-gdo.mjs <file.csv> --invia    (invia)
//
// CSV: ';' come separatore, prima riga di intestazione. Le colonne si leggono PER NOME,
// non per posizione: il CRM ne ha già cambiato l'ordine una volta e una lettura
// posizionale avrebbe spedito i campi sbagliati senza accorgersene. Servono
// Telefono, Nome, Appuntamento, LeadId, GDO, Funnel (Email è facoltativa); se una manca
// non parte niente.
//
// Regole:
// - i lead del bot (GDO 201) non ricevono l'agenda: sono già nostri, hanno già il video
//   e si sono prenotati da soli. Esclusione via ESCLUDI_GDO (regex, default /201|bot/i);
// - chi ha già ricevuto QUESTO template da noi viene saltato: rilanciare lo script dopo
//   un'interruzione non manda niente due volte;
// - gli appuntamenti già passati non partono;
// - ordine per data appuntamento, prima i più imminenti;
// - throttling a ~25 invii/minuto, finestra oraria 09:00-20:30 di Roma;
// - il template si verifica prima di spedire (approved + UTILITY), anche in dry run.
import fs from 'node:fs';
import { assertApprovedUtility, twilioAuth } from './lib/template-guard.mjs';

const CSV = process.argv.find((a) => a.toLowerCase().endsWith('.csv'));
if (!CSV) throw new Error('manca il CSV: node ... scripts/invio-agenda-gdo.mjs <file.csv> [--invia]');
const LIVE = process.argv.includes('--invia');
const PER_MIN = 25;
const LIMITE = process.env.LIMITE ? Number(process.env.LIMITE) : Infinity;
const ESCLUDI_GDO = new RegExp(process.env.ESCLUDI_GDO ?? '\\b201\\b|bot', 'i');

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TW_SID = process.env.TWILIO_ACCOUNT_SID;
const AGENDA_SID = process.env.AGENDA_GDO_TEMPLATE_SID;
if (!SUPA || !KEY || !TW_SID || !AGENDA_SID) throw new Error('env mancanti (supabase/twilio/AGENDA_GDO_TEMPLATE_SID)');

// Il valore letto da .env.local può arrivare con virgolette o con il \r di fine riga
// Windows: Twilio risponde 21212 ("From non valido") e non parte nulla.
const FROM_RAW = process.env.FROM_OVERRIDE || process.env.TWILIO_WHATSAPP_NUMBER_FENICE || '';
if (/SENSITIVE|^$/.test(FROM_RAW.trim())) throw new Error('mittente non configurato: passa FROM_OVERRIDE=whatsapp:+39...');
const FROM = (() => {
  const v = FROM_RAW.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  return v.startsWith('whatsapp:') ? v : `whatsapp:${v}`;
})();

// Dove Twilio ci richiama con lo stato di consegna: lo stesso webhook dell'app.
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/^["']|["']$/g, '').replace(/\/$/, '');
if (!APP_URL) throw new Error('NEXT_PUBLIC_APP_URL mancante: senza status callback gli stati restano "queued"');
const STATUS_CALLBACK = `${APP_URL}/api/webhooks/twilio`;

// Link di prenotazione e testo: copia esatta di lib/gdo-agenda.ts. Il testo si scrive in
// cronologia al posto di "[template]" perché l'inbox — e Mario, che legge la stessa
// cronologia — vedano il messaggio vero.
const BOOKING_LINK = 'https://form.jotform.com/240755654585063';
const gdoAgendaText = (nome) =>
  `Ciao ${nome}, sono Marta di Fenice Academy 🙂 come ti ha detto il mio collega ` +
  `ti mando qui il link per scegliere giorno e ora della videocall 👉 ${BOOKING_LINK}\n` +
  `Rispondimi qui con un ok quando l'hai aperto, così ti mando il video da vedere prima della call`;

// Il video che partirà alla risposta del lead. Il CSV del CRM non porta la variante
// lavora/famiglia: Bruno ha deciso il video dell'offerta del mese per tutti (31/07).
const VIDEO_URL = process.env.VIDEO_URL ?? 'https://corso.feniceacademy.it/conferenza-black-summer';

// --- nome: copia di lib/name.ts (firstNameOf + templateName) ---------------------
const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ'’\\-";
const VALID_TOKEN = new RegExp(`^[${LETTER}]{2,}$`);
const EDGE_JUNK = new RegExp(`^[^${LETTER}]+|[^${LETTER}]+$`, 'g');
const PLACEHOLDERS = new Set(['test', 'prova', 'asd', 'xxx', 'admin', 'nessuno', 'nome', 'cognome', 'cliente', 'utente', 'privato']);
const COMPANY_MARKERS = new Set(['azienda', 'ditta', 'srl', 'spa', 'sas', 'snc', 'sl']);
const NEUTRAL_VOCATIVE = 'a te';
const titleCase = (s) => s.toLowerCase().replace(/(^|['’-])([a-zà-öø-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());
const firstNameOf = (raw) => {
  if (!raw) return null;
  const words = raw.trim().split(/\s+/);
  if (words.some((w) => COMPANY_MARKERS.has(w.replace(EDGE_JUNK, '').toLowerCase()))) return null;
  const cleaned = (words[0] ?? '').replace(EDGE_JUNK, '');
  if (!VALID_TOKEN.test(cleaned)) return null;
  if (PLACEHOLDERS.has(cleaned.toLowerCase())) return null;
  return titleCase(cleaned);
};
const templateName = (raw) => firstNameOf(raw) ?? NEUTRAL_VOCATIVE;

// --- telefono: copia di lib/phone.ts ---------------------------------------------
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

// "31/07/2026 15:00" -> timestamp (ora di Roma). L'anno qui c'è sempre.
const quando = (s) => {
  const [d, o = '00:00'] = String(s ?? '').trim().split(/\s+/);
  const [gg, mm, aaaa] = String(d ?? '').split('/');
  if (!gg || !mm || !aaaa) return NaN;
  return Date.parse(`${aaaa}-${mm.padStart(2, '0')}-${gg.padStart(2, '0')}T${o}:00+02:00`);
};

const oraRoma = () => {
  const p = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: 'numeric', minute: 'numeric', hour12: false })
    .formatToParts(new Date());
  const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return g('hour') * 60 + g('minute');
};

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

// --- lettura del CSV per nome di colonna -----------------------------------------
const linee = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const intest = linee[0].split(';').map((c) => c.trim().toLowerCase().replace(/^\ufeff/, ''));
const col = (nome) => {
  const i = intest.indexOf(nome);
  if (i === -1) throw new Error(`colonna "${nome}" assente dal CSV (trovate: ${intest.join(', ')})`);
  return i;
};
const iTel = col('telefono'), iNome = col('nome'), iApp = col('appuntamento');
const iId = col('leadid'), iGdo = col('gdo'), iFun = col('funnel');
const iMail = intest.indexOf('email');

const righe = linee.slice(1).map((l) => {
  const c = l.split(';').map((x) => (x ?? '').trim());
  return {
    nome: c[iNome], telefono: c[iTel], appuntamento: c[iApp], leadId: c[iId],
    gdo: c[iGdo], funnel: c[iFun], email: iMail === -1 ? '' : c[iMail],
    phone: toE164(c[iTel]),
  };
});

const scartati = [];
const tieni = [];
const visti = new Set();
for (const r of righe) {
  if (ESCLUDI_GDO.test(r.gdo)) scartati.push({ ...r, perche: `lead del bot, non di un GDO (${r.gdo})` });
  else if (!r.phone) scartati.push({ ...r, perche: `telefono non valido (${r.telefono})` });
  else if (!/^[0-9a-f-]{36}$/i.test(r.leadId)) scartati.push({ ...r, perche: `LeadId non valido (${r.leadId})` });
  else if (!Number.isFinite(quando(r.appuntamento))) scartati.push({ ...r, perche: `data illeggibile (${r.appuntamento})` });
  else if (quando(r.appuntamento) < Date.now() && process.env.INCLUDI_PASSATI !== '1') scartati.push({ ...r, perche: `appuntamento già passato (${r.appuntamento})` });
  else if (visti.has(r.phone)) scartati.push({ ...r, perche: `telefono ripetuto nel CSV (${r.phone})` });
  else { visti.add(r.phone); tieni.push(r); }
}
const target = tieni.sort((a, b) => quando(a.appuntamento) - quando(b.appuntamento));
console.log(`CSV: ${righe.length} righe | candidati: ${target.length} | scartati: ${scartati.length}`);
for (const s of scartati) console.log(`   escluso: ${s.nome} (${s.telefono}) ${s.gdo} ${s.appuntamento} -> ${s.perche}`);

// Chi ha già ricevuto QUESTO template da noi non lo riceve due volte: vale per le liste
// del CRM che si sovrappongono e per un rilancio dopo un'interruzione a metà.
const gia = new Set();
for (let i = 0; i < target.length; i += 25) {
  const chunk = target.slice(i, i + 25).map((r) => enc(r.phone)).join(',');
  const leads = await sb(`leads?select=id,phone_e164&phone_e164=in.(${chunk})`);
  if (!leads?.length) continue;
  const convs = await sb(`conversations?select=id,lead_id&lead_id=in.(${leads.map((l) => l.id).join(',')})`);
  if (!convs?.length) continue;
  const msgs = await sb(`messages?select=conversation_id&conversation_id=in.(${convs.map((c) => c.id).join(',')})&direction=eq.out&template_sid=eq.${AGENDA_SID}`);
  const convHa = new Set((msgs ?? []).map((m) => m.conversation_id));
  for (const c of convs) {
    if (!convHa.has(c.id)) continue;
    const lead = leads.find((l) => l.id === c.lead_id);
    if (lead) gia.add(lead.phone_e164);
  }
}
const finali = target.filter((r) => !gia.has(r.phone));
console.log(`agenda già inviata da noi (saltati): ${target.length - finali.length}`);
console.log(`DA INVIARE: ${finali.length}`);
console.log(`${LIVE ? '*** INVIO REALE ***' : 'DRY RUN'} | mittente ...${FROM.slice(-4)} | template ${AGENDA_SID.slice(0, 12)}… | video alla risposta: ${VIDEO_URL}\n`);

// Finestra oraria: non si scrive a nessuno alle 3 di notte per un errore di lancio.
if (LIVE && (oraRoma() < 9 * 60 || oraRoma() >= 20 * 60 + 30) && process.env.FORZA_ORARIO !== '1') {
  throw new Error(`fuori finestra 09:00-20:30 (ora di Roma: ${Math.floor(oraRoma() / 60)}:${String(oraRoma() % 60).padStart(2, '0')}). FORZA_ORARIO=1 per forzare.`);
}

// Presidio: si chiede a Meta come ha classificato DAVVERO il template. Fail-closed,
// e vale anche in dry run: l'errore va visto prima di lanciare l'invio, non dopo.
const twAuth = twilioAuth();
const appro = await assertApprovedUtility(AGENDA_SID, { auth: twAuth });
console.log(`template ${AGENDA_SID.slice(0, 12)}… ${appro.name ?? ''} → ${appro.status} ${appro.category}${appro.override ? ' (override)' : ''}\n`);

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const esiti = { csv: CSV, inviati: 0, falliti: 0, saltati: target.length - finali.length, scartati, errori: [] };
const daFare = finali.slice(0, LIMITE);

for (const [i, r] of daFare.entries()) {
  const nome = templateName(r.nome);

  if (!LIVE) {
    console.log(`[dry] ${String(i + 1).padStart(2)} ${nome.padEnd(12)} ${r.phone.padEnd(14)} ${r.appuntamento.padEnd(17)} ${r.gdo.padEnd(8)} ${r.funnel}`);
    continue;
  }

  let conversationId;
  try {
    ({ conversationId } = await trovaOCrea(r.phone, r.nome, r.email));
    const body = new URLSearchParams({
      To: `whatsapp:${r.phone}`,
      From: FROM,
      ContentSid: AGENDA_SID,
      ContentVariables: JSON.stringify({ 1: nome }),
      // Senza questo Twilio non ci richiama e i nostri stati restano "queued" per
      // sempre: l'inbox mente e `handleGdoDeliveryUpdate` non vede mai la consegna.
      // Lo passa già ogni invio dell'app (lib/twilio.ts): qui era l'unico buco.
      StatusCallback: STATUS_CALLBACK,
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
        body: gdoAgendaText(nome),
        twilio_sid: msg.sid, twilio_status: msg.status,
        template_sid: AGENDA_SID, is_template: true,
        sender: 'automazione',
      }),
      headers: { Prefer: 'return=minimal' },
    });
    await modalitaPostino(conversationId, r, 'inviato');
    esiti.inviati++;
    console.log(`  ok  ${String(i + 1).padStart(2)}/${daFare.length} ${nome.padEnd(12)} ${r.phone} conv ${conversationId} ${msg.status}`);
  } catch (e) {
    esiti.falliti++;
    esiti.errori.push({ nome: r.nome, telefono: r.phone, gdo: r.gdo, appuntamento: r.appuntamento, errore: String(e.message ?? e) });
    // L'esito 'fallito' è quello che permette al CRM (e a noi) di ritentare: la
    // deduplica a 15 minuti di /send-agenda non blocca i falliti.
    if (conversationId) await modalitaPostino(conversationId, r, 'fallito').catch(() => {});
    console.log(`  KO  ${String(i + 1).padStart(2)}/${daFare.length} ${nome.padEnd(12)} ${r.phone} -> ${e.message ?? e}`);
  }

  if (i < daFare.length - 1) await pausa(Math.ceil(60000 / PER_MIN));
}

async function trovaOCrea(phone, nome, email) {
  const payload = { phone_e164: phone };
  // Il DB conserva il nome completo (serve in inbox): è l'invio che usa solo il proprio.
  if (nome) payload.first_name = nome;
  if (email) payload.email = email;
  const up = await sb('leads?on_conflict=phone_e164', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  const leadId = up[0].id;
  const esiste = await sb(`conversations?select=id&lead_id=eq.${leadId}&order=id.asc&limit=1`);
  if (esiste.length) return { leadId, conversationId: esiste[0].id };
  const nuova = await sb('conversations', {
    method: 'POST',
    body: JSON.stringify({ lead_id: leadId }),
    headers: { Prefer: 'return=representation' },
  });
  return { leadId, conversationId: nuova[0].id };
}

// Stessi campi di enrollGdoLeadAsPostino: senza questi il video non parte alla risposta
// e i cron tratterebbero il lead come uno dei nostri.
async function modalitaPostino(conversationId, r, esito) {
  const now = new Date().toISOString();
  await sb(`conversations?id=eq.${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ai_owner: 'mario',
      ai_status: 'active',
      ai_started_at: now,
      ai_lock_at: null,
      crm_lead_id: r.leadId,
      crm_funnel: r.funnel || null,
      gdo_agenda_at: now,
      gdo_agenda_esito: esito,
      gdo_video_url: VIDEO_URL,
      gdo_video_sent_at: null,
      last_message_at: now,
    }),
    headers: { Prefer: 'return=minimal' },
  });
  await sb('event_log', {
    method: 'POST',
    body: JSON.stringify({
      type: esito === 'inviato' ? 'gdo_agenda_sent' : 'send_error',
      payload: { phone: r.phone, conversationId, crmLeadId: r.leadId, script: 'invio-agenda-gdo' },
      message: esito === 'inviato'
        ? `[gdo] agenda inviata (script) per conto del GDO a ${r.phone}`
        : `[gdo] agenda fallita (script) per ${r.phone}`,
      level: esito === 'inviato' ? 'info' : 'error',
    }),
    headers: { Prefer: 'return=minimal' },
  });
}

if (LIVE) {
  console.log(`\n=== ESITO === inviati: ${esiti.inviati} | falliti: ${esiti.falliti} | saltati (già serviti): ${esiti.saltati}`);
  if (esiti.errori.length) {
    console.log('\nnumeri andati in errore (da girare al CRM):');
    for (const e of esiti.errori) console.log(`  ${e.nome};${e.telefono};${e.gdo};${e.appuntamento};${e.errore}`);
  }
  const out = `C:/Users/bruno/Desktop/esito-invio-agenda-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(out, JSON.stringify(esiti, null, 2));
  console.log(`\nreport salvato in ${out}`);
}
