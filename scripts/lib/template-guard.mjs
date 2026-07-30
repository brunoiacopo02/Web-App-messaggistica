// Presidio sui template WhatsApp: nessuno script spedisce un template senza aver
// verificato COME META L'HA CLASSIFICATO, non come noi l'avevamo chiesto.
//
// Il 29/07/2026 sono partiti 69 messaggi col template parametrico MARKETING, che era
// già stato scartato la mattina stessa: lo script aveva quel modo come default e la
// categoria vera non veniva mai controllata prima dell'invio. Il default di uno script
// non è una decisione approvata — da qui in poi lo dice il codice, non la memoria.
//
// Uso come guardia:
//   import { assertApprovedUtility } from './lib/template-guard.mjs';
//   await assertApprovedUtility(sid, { auth });   // lancia se non è approved+UTILITY
//
// Uso come audit (elenca la categoria vera di tutti i SID in env):
//   node --env-file=.env.local scripts/lib/template-guard.mjs

import { pathToFileURL } from 'node:url';

const API = 'https://content.twilio.com/v1/Content';

/** Credenziali Twilio in header Basic, dalle env. */
export function twilioAuth(env = process.env) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
  return 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64');
}

/** Stato di approvazione reale di un template (categoria decisa da Meta, non richiesta). */
export async function readApproval(sid, { fetchImpl = fetch, auth } = {}) {
  const res = await fetchImpl(`${API}/${sid}/ApprovalRequests`, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const w = body?.whatsapp ?? {};
  return { status: w.status ?? null, category: w.category ?? null, name: w.name ?? null };
}

/**
 * Lancia se il template non è `approved` + `UTILITY`. Fail-closed: se la Content API
 * non risponde ci si ferma, perché non sapere cosa si sta spedendo è esattamente la
 * condizione dell'incidente.
 *
 * L'unico sblocco è `TEMPLATE_GUARD_OVERRIDE=<sid>`: va scritto il SID per esteso, così
 * non esiste un bypass generico e la scelta resta di una persona, un template alla volta.
 */
export async function assertApprovedUtility(sid, { fetchImpl = fetch, auth, env = process.env } = {}) {
  if (!sid) throw new Error('template-guard: SID del template mancante');

  const override = (env.TEMPLATE_GUARD_OVERRIDE ?? '').trim() === sid;

  let approval;
  try {
    approval = await readApproval(sid, { fetchImpl, auth });
  } catch (e) {
    throw new Error(
      `template-guard: verifica del template ${sid} non riuscita (${e.message}). ` +
      'Non si spedisce senza sapere come Meta l\'ha classificato.',
    );
  }

  if (override) {
    console.warn(
      `⚠️  template-guard: ${sid} (${approval.name ?? 'senza nome'}) è ${approval.category}, ` +
      'ma TEMPLATE_GUARD_OVERRIDE lo autorizza esplicitamente.',
    );
    return { ...approval, override: true };
  }

  if (approval.status !== 'approved') {
    throw new Error(
      `template-guard: il template ${sid} (${approval.name ?? 'senza nome'}) è "${approval.status}", non approved. ` +
      'Nessun invio finché Meta non lo approva.',
    );
  }
  if (approval.category !== 'UTILITY') {
    throw new Error(
      `template-guard: il template ${sid} (${approval.name ?? 'senza nome'}) è ${approval.category}, non UTILITY. ` +
      'I MARKETING pesano sul quality rating del numero e incontrano i limiti per-utente di Meta: ' +
      'usa un template UTILITY, oppure autorizza questo con TEMPLATE_GUARD_OVERRIDE=' + sid + '.',
    );
  }
  return { ...approval, override: false };
}

/** Audit: categoria reale di ogni SID template presente in env. */
async function audit() {
  const auth = twilioAuth();
  // Qualunque env che contenga un Content SID: i nomi non seguono una convenzione
  // unica (SEQ_TEMPLATE_SID_1, OPENING_SID_C2, MARTA_REENGAGE_TEMPLATE_SID…).
  const voci = Object.entries(process.env)
    .filter(([, v]) => typeof v === 'string' && /^HX[0-9a-f]{32}$/i.test(v.trim().replace(/^["']|["']$/g, '')))
    .map(([k, v]) => [k, v.trim().replace(/^["']|["']$/g, '')])
    .sort(([a], [b]) => a.localeCompare(b));
  if (voci.length === 0) return console.log('nessun SID template in env');
  for (const [chiave, sid] of voci) {
    try {
      const a = await readApproval(sid, { auth });
      const spia = a.status === 'approved' && a.category === 'UTILITY' ? '✅' : '⚠️ ';
      console.log(`${spia} ${chiave.padEnd(32)} ${sid}  ${a.status}  ${a.category}  ${a.name ?? ''}`);
    } catch (e) {
      console.log(`❓ ${chiave.padEnd(32)} ${sid}  verifica fallita: ${e.message}`);
    }
  }
}

// Eseguito direttamente (non importato)? Su Windows il confronto va fatto sugli URL:
// `file:///C:/...` non coincide mai con una concatenazione a mano del path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await audit();
