// Sorveglia l'approvazione del template "offerta del mese" e, appena passa, fa
// partire l'invio ai 51 lead rimasti del recupero Spoki del 28/07.
//
// Uso: FROM_OVERRIDE=whatsapp:+39... node --env-file=.env.local scripts/attendi-e-invia-offerta.mjs
//
// Condizioni per far partire l'invio (entrambe):
//   1. il template è 'approved' lato WhatsApp;
//   2. l'ora di Roma è tra le 09:00 e le 20:30 (indicazione del CRM "non prima delle
//      9:00" + la nostra finestra d'invio).
// Se il template passa di notte, l'invio aspetta le 09:00.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Due sottomissioni identiche in coda: la v2 è ferma da 17h, la v3 è la riserva.
// Si parte con la prima che viene approvata.
const TEMPLATES = [
  { sid: 'HX5937707e177b4272fba2aed3e8393cee', nome: 'offerta v2' },
  { sid: 'HX4c41710aede255de338a88c1b9f0cac2', nome: 'offerta v3' },
];
const LOG = 'C:/Users/bruno/Desktop/watch-invio-offerta.log';
const OGNI_MS = 2 * 60 * 1000;
// Il CRM vuole saperlo subito se non passa entro le 11:00 del 29/07: da lì in poi
// partono loro con l'invio manuale sui lead urgenti.
const ALLARME_ORE = 11;

const SID = process.env.TWILIO_ACCOUNT_SID, TOK = process.env.TWILIO_AUTH_TOKEN;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const log = (m) => {
  const riga = `[${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}] ${m}`;
  console.log(riga);
  fs.appendFileSync(LOG, riga + '\n');
};

const oraRoma = () => {
  const p = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: 'numeric', minute: 'numeric', hour12: false })
    .formatToParts(new Date());
  const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return g('hour') * 60 + g('minute');
};
const inFinestra = () => { const m = oraRoma(); return m >= 9 * 60 && m < 20 * 60 + 30; };

const statoDi = async (sid) => {
  const r = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, { headers: { Authorization: auth } });
  if (!r.ok) return { status: `http_${r.status}` };
  return (await r.json()).whatsapp ?? {};
};
// Ritorna la prima copia approvata, altrimenti il quadro complessivo.
const stato = async () => {
  const esiti = [];
  for (const t of TEMPLATES) {
    const s = await statoDi(t.sid);
    if (s.status === 'approved') return { ...s, sid: t.sid, nome: t.nome };
    esiti.push(`${t.nome}=${s.status ?? '?'}`);
  }
  const rifiutati = esiti.filter((e) => e.includes('rejected')).length;
  return { status: rifiutati === TEMPLATES.length ? 'rejected' : 'pending', dettaglio: esiti.join(' ') };
};

log('watcher avviato: attendo approvazione del template offerta-mese (51 lead)');
let allarmeDato = false;

while (true) {
  const s = await stato();
  const finestra = inFinestra();

  if (s.status === 'approved' && finestra) {
    log(`template APPROVATO: ${s.nome} (cat=${s.category ?? '?'}) e siamo in finestra: avvio invio dei rimanenti`);
    const p = spawn(process.execPath, ['--env-file=.env.local', 'scripts/invio-video-recupero-spoki.mjs', '--invia'], {
      cwd: 'C:/Users/bruno/Desktop/Software Messaggistica',
      env: { ...process.env, MODO_INVIO: 'per-slug', SOLO_SLUG: 'offerta-mese', SID_OFFERTA: s.sid },
    });
    p.stdout.on('data', (d) => log(String(d).trimEnd()));
    p.stderr.on('data', (d) => log('ERR ' + String(d).trimEnd()));
    await new Promise((res) => p.on('close', (c) => { log(`invio concluso, exit=${c}`); res(); }));
    break;
  }

  if (s.status === 'rejected') { log(`template RIFIUTATO: ${s.rejection_reason ?? 'motivo non indicato'} — serve intervento a mano`); break; }
  if (s.status === 'approved' && !finestra) log('template approvato, ma fuori finestra: aspetto le 09:00');
  else log(`stato template: ${s.dettaglio ?? s.status ?? '?'}`);

  const oggi29 = new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }).startsWith('29/07');
  if (!allarmeDato && oggi29 && oraRoma() >= ALLARME_ORE * 60 && s.status !== 'approved') {
    log('*** ALLARME: sono le 11:00 del 29/07 e il template non è ancora approvato. Avvisare il CRM: partono loro a mano sui 49 urgenti. ***');
    allarmeDato = true;
  }

  await new Promise((r) => setTimeout(r, OGNI_MS));
}
log('watcher terminato');
