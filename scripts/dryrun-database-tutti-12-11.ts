/**
 * Giovedi' 12/11/2026 (PO: "dobbiamo scrivere a tutti ma a scaglioni divisi per i numeri").
 * PROVA A SECCO, SOLA LETTURA: nessuna chat creata o toccata, nessun WhatsApp, niente in
 * `event_log`. Meta' bot della prova; la meta' CRM e' lo script
 * `scripts/diretta/dryrun-database-tutti-12-11.ts` del repo CRM, che scrive il file letto qui.
 *
 * Per ogni lead che il CRM farebbe entrare esegue l'arruolamento VERO (`enrollDatabaseLead`)
 * con le letture vere (chat, messaggi, tetti, qualita' dei numeri, approvazione Meta dei
 * template) e le scritture finte, tenendo in memoria le aperture simulate: cosi' la
 * divisione sui numeri e' quella che farebbe il giro vero, nello stesso ordine.
 *
 *   bun --env-file=.env.production.local scripts/dryrun-database-tutti-12-11.ts --in=dryrun-crm.json
 *       [--settings='{"attivo":true,...}'] [--out=percorso.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getSupabaseAdmin } from '../lib/supabase/admin';
import { depsDatabase, enrollDatabaseLead, type DepsDatabase } from '../lib/database-enroll';
import { ENV_SID_DATABASE, parseSettingsDatabase } from '../lib/database-bot';
import { toE164 } from '../lib/phone';

/** Il SID del template `fenice_apertura_database_bf_v1` sull'account principale (non e' un segreto). */
const SID_BF_PRINCIPALE = 'HX9349ea71c6c4151393961b623560b740';
const SETTINGS_PROPOSTE = { attivo: true, tetto_giorno: 60, tetto_numero: 11, varianti: ['bf'], giorni_fermo: 7, riapri_tutti: true, fuori_tetto: true };

/** Il template bf sui tre account Twilio (SID pubblici; le credenziali stanno nelle env). */
const BF_PER_ACCOUNT = [
  { account: 'principale', sid: SID_BF_PRINCIPALE, envSid: 'TWILIO_ACCOUNT_SID', envToken: 'TWILIO_AUTH_TOKEN' },
  { account: 'fenice2', sid: 'HX1e01d7755bc088e40dfcedf6846eac76', envSid: 'TWILIO_ACCOUNT_SID_2', envToken: 'TWILIO_AUTH_TOKEN_2' },
  { account: 'elixir', sid: 'HX28594f54c0264b349536b06443286e80', envSid: 'TWILIO_ACCOUNT_SID_3', envToken: 'TWILIO_AUTH_TOKEN_3' },
];

/** Stato Meta del template bf su ogni account (sola lettura, Content API). */
async function approvazioneBf(): Promise<{ account: string; stato: string }[]> {
  const out: { account: string; stato: string }[] = [];
  for (const a of BF_PER_ACCOUNT) {
    const sid = (process.env[a.envSid] ?? '').trim();
    const token = (process.env[a.envToken] ?? '').trim();
    if (!sid.startsWith('AC') || !token || token.includes('SENSITIVE')) { out.push({ account: a.account, stato: 'credenziali non leggibili in locale' }); continue; }
    try {
      const r = await fetch(`https://content.twilio.com/v1/Content/${a.sid}/ApprovalRequests`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
      });
      const j = r.ok ? await r.json() as { whatsapp?: { status?: string; category?: string; name?: string } } : null;
      out.push({ account: a.account, stato: j ? `${j.whatsapp?.status ?? '?'} (${j.whatsapp?.category ?? '?'}, ${j.whatsapp?.name ?? '?'})` : `HTTP ${r.status}` });
    } catch (e) {
      out.push({ account: a.account, stato: `errore ${(e as Error).message}` });
    }
  }
  return out;
}

type RigaCrm = {
  rigaCodaId: string; leadId: string; nome: string | null; telefono: string | null; email: string | null; funnel: string | null;
  stato: string; entra: boolean; regola: string | null; sposta: boolean | null; motivo: string | null;
};

function arg(nome: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${nome}=`))?.split('=').slice(1).join('=');
}
const coda = (n: string | null | undefined) => (n ?? '').replace(/\D/g, '').slice(-4) || '—';

async function main() {
  const file = arg('in');
  if (!file) throw new Error('manca --in=<file scritto dal dry-run del CRM>');
  const righe = (JSON.parse(readFileSync(file, 'utf8')) as { righe: RigaCrm[] }).righe;
  const settingsGrezze = arg('settings') ? JSON.parse(arg('settings') as string) : SETTINGS_PROPOSTE;
  const settings = parseSettingsDatabase(settingsGrezze);

  const envBfPresente = !!(process.env[ENV_SID_DATABASE.bf] ?? '').trim();
  console.log(`${ENV_SID_DATABASE.bf} nelle env caricate: ${envBfPresente ? 'presente' : 'ASSENTE (per la prova uso il SID del principale)'}`);
  if (!envBfPresente) process.env[ENV_SID_DATABASE.bf] = SID_BF_PRINCIPALE;
  console.log('Impostazioni simulate (NON scritte):', JSON.stringify(settingsGrezze));

  const supabase = getSupabaseAdmin();
  const veri = depsDatabase(supabase);

  // Le env locali non hanno i numeri della produzione (BOT_NUMERI_SECONDARI e' cifrata):
  // se il giro letto dalle env e' monco, si usano i numeri con un tetto in `tetti_numeri`
  // (quelli che in produzione aprono davvero) piu' il primario. L'ordine conta solo a parita'.
  const tettiLetti = await veri.tetti();
  let giroNumeri = veri.numeri();
  if (giroNumeri.length < 3 && tettiLetti) {
    const daTetti = [...tettiLetti.keys()].map((n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`));
    giroNumeri = [...daTetti, ...giroNumeri.filter((n) => !daTetti.includes(n))];
    console.log('Numeri del giro presi da tetti_numeri (env locali senza i secondari).');
  }
  // Approvazione Meta del template bf: letta account per account. Nella simulazione un
  // numero "puo' spedire" solo se il bf e' approvato su TUTTI e tre gli account (in locale
  // non si sa quale numero sta su quale account).
  const approvazioni = await approvazioneBf();
  console.log('Template bf (fenice_apertura_database_bf_v1) per account:', JSON.stringify(approvazioni));
  const bfOvunque = approvazioni.every((a) => a.stato.startsWith('approved'));
  if (!bfOvunque) console.log('ATTENZIONE: bf non risulta approvato su tutti gli account: la simulazione non apre da nessun numero.');
  // Aperture simulate in questa prova, per numero.
  const sim: Record<string, number> = {};
  let simRiaperte = 0;
  let convFinta = 9_000_000;
  let ultimoEvento: Record<string, unknown> | null = null;
  const deps: DepsDatabase = {
    ...veri,
    numeri: () => giroNumeri,
    credenzialiOk: () => true,
    approvato: async () => bfOvunque,
    leggiSettings: async () => settings,
    contaDatabaseOggi: async (numero) => {
      const v = await veri.contaDatabaseOggi(numero);
      if (v === null) return null;
      return v + (numero ? (sim[numero] ?? 0) : Object.values(sim).reduce((a, b) => a + b, 0));
    },
    apertureOggi: async (numero) => {
      const v = await veri.apertureOggi(numero);
      return v === null ? null : v + (sim[numero] ?? 0);
    },
    contaRiapertureOggi: async () => {
      const v = await veri.contaRiapertureOggi();
      return v === null ? null : v + simRiaperte;
    },
    // ── scritture finte ──
    creaChat: async (a) => ({ conversationId: convFinta++, waNumber: a.mittente }),
    aggiornaChat: async () => true,
    registraApertura: async (a) => { sim[a.numero] = (sim[a.numero] ?? 0) + 1; },
    invia: async () => ({ ok: true, sid: 'DRYRUN' }),
    log: async (_type, _level, payload) => { ultimoEvento = payload; },
  };

  const tetti = tettiLetti;
  const qualita = await veri.statoQualita();
  console.log('\nNumeri del giro prima della prova (aperture di oggi / tetto ordinario):');
  for (const n of giroNumeri) {
    const oggi = await veri.apertureOggi(n);
    console.log(`  ${coda(n)}: ${oggi ?? '?'} / ${tetti?.get(n) ?? tetti?.get(n.replace('whatsapp:', '')) ?? 'nessun tetto (a riposo)'}`);
  }
  console.log('  qualita (ultime letture):', JSON.stringify(Object.fromEntries(Object.entries(qualita?.storico ?? {}).map(([k, v]) => [coda(k), Object.entries(v).slice(-2).map(([g, q]) => `${g.slice(5)} ${q}`).join(', ')]))));

  const esiti: Array<RigaCrm & { esitoBot: string; numero: string | null; dettaglio: string | null }> = [];
  for (const r of righe) {
    if (!r.entra) { esiti.push({ ...r, esitoBot: 'non_spinto', numero: null, dettaglio: null }); continue; }
    const phone = toE164(r.telefono ?? '');
    if (!phone) { esiti.push({ ...r, entra: false, motivo: 'telefono_non_valido', esitoBot: 'rifiuto', numero: null, dettaglio: 'telefono_non_valido' }); continue; }
    ultimoEvento = null;
    const e = await enrollDatabaseLead(supabase, { phone, firstName: r.nome, email: r.email, crmLeadId: r.leadId, crmFunnel: r.funnel }, deps);
    if (e.tipo === 'aperto') {
      const ev = ultimoEvento as { riaperta?: boolean; numeroPrima?: string | null } | null;
      if (ev?.riaperta) simRiaperte++;
      const come = !ev?.riaperta ? 'chat nuova'
        : ev.numeroPrima !== undefined ? `chat ${e.conversationId} riaperta, spostata dal ${coda(ev.numeroPrima)}` : `chat ${e.conversationId} riaperta sul suo numero`;
      esiti.push({ ...r, esitoBot: 'aperto', numero: coda(e.numero), dettaglio: come });
    } else if (e.tipo === 'duplicato') {
      esiti.push({ ...r, entra: false, motivo: 'gia_aperto_dal_database', esitoBot: 'duplicato', numero: null, dettaglio: null });
    } else {
      esiti.push({ ...r, entra: false, motivo: `bot: ${e.dettaglio}`, esitoBot: e.motivo, numero: null, dettaglio: e.dettaglio });
    }
  }

  console.log('\nriga      lead      nome                        esito');
  for (const x of esiti) {
    console.log([
      x.rigaCodaId.slice(0, 8), x.leadId.slice(0, 8), (x.nome ?? '').slice(0, 26).padEnd(26),
      x.entra ? `ENTRA dal ${x.numero} · ${x.dettaglio}${x.sposta ? '' : ' · scheda NON spostata'}` : `FUORI ${x.motivo}`,
    ].join('  '));
  }
  const conta = (ch: string[]) => ch.reduce<Record<string, number>>((m, k) => { m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const dentro = esiti.filter((x) => x.entra);
  console.log(`\nENTRANO ${dentro.length} su ${esiti.length}. Per numero:`, conta(dentro.map((x) => String(x.numero))));
  console.log('Come:', conta(dentro.map((x) => (x.dettaglio ?? '').replace(/chat \d+ /, 'chat ').replace(/dal \d+$/, 'da un altro numero'))));
  console.log('Scheda spostata all\'account bot:', dentro.filter((x) => x.sposta).length, '· lasciata dov\'e\':', dentro.filter((x) => !x.sposta).length);
  console.log(`FUORI ${esiti.length - dentro.length}:`, conta(esiti.filter((x) => !x.entra).map((x) => String(x.motivo))));
  console.log('\nId riga che ENTRANO:\n' + dentro.map((x) => `'${x.rigaCodaId}'`).join(','));

  const out = arg('out');
  if (out) { writeFileSync(out, JSON.stringify({ settings: settingsGrezze, esiti }, null, 2), 'utf8'); console.log(`\nScritto ${out}`); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
