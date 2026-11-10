/* eslint-disable @typescript-eslint/no-explicit-any */
// Crea i due template della scheda del corso (campagna brochure, PO 10/11/2026, testi in
// lib/scheda-template.ts) su OGNI account Twilio da cui il bot manda e ne chiede
// l'approvazione a Meta come UTILITY. Un account = una WABA:
//   principale -> 3199, 8061;  slot 2 -> 0047;  slot 3 -> 8718, 2245, 2508
// I SID dell'account principale vanno in SCHEDA_TEMPLATE_SID e SCHEDA_SCELTA_TEMPLATE_SID:
// gli altri account li ritrovano per nome, quindi il friendly_name e' lo STESSO ovunque.
//
// Idempotente: se il nome esiste gia' non lo ricrea; se manca solo la richiesta di
// approvazione, la manda. Senza --invia stampa e basta; con --stato stampa lo stato.
//
// Uso: bun --env-file="<percorso>/.env.local" scripts/crea-template-scheda-brochure.ts [--invia|--stato]
import {
  NOME_TEMPLATE_SCHEDA, NOME_TEMPLATE_SCELTA_CORSO, BASE_URL_SCHEDE,
  testoTemplateScheda, testoTemplateSceltaCorso,
} from '../lib/scheda-template';

const TEMPLATE: { nome: string; variabili: Record<string, string>; types: any; descr: string }[] = [
  {
    nome: NOME_TEMPLATE_SCHEDA,
    variabili: { '1': 'Giulia', '2': 'Social Media Manager', '3': 'social-media-manager.pdf' },
    // twilio/media su WhatsApp = template con header media; un .pdf diventa header DOCUMENT.
    types: { 'twilio/media': { body: testoTemplateScheda('{{1}}', '{{2}}'), media: [`${BASE_URL_SCHEDE}{{3}}`] } },
    descr: `header documento ${BASE_URL_SCHEDE}{{3}}
testo: ${testoTemplateScheda('{{1}}', '{{2}}')}`,
  },
  {
    nome: NOME_TEMPLATE_SCELTA_CORSO,
    variabili: { '1': 'Giulia' },
    types: { 'twilio/text': { body: testoTemplateSceltaCorso('{{1}}') } },
    descr: `testo: ${testoTemplateSceltaCorso('{{1}}')}`,
  },
];
for (const t of TEMPLATE) {
  const corpo = JSON.stringify(t.types);
  if (/€|euro|prezzo|sconto|offerta|gratis/i.test(corpo)) throw new Error(`${t.nome}: testo promozionale`);
}

const ACCOUNT: { etichetta: string; sid?: string; token?: string }[] = [
  { etichetta: 'principale', sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN },
  { etichetta: 'slot 2', sid: process.env.TWILIO_ACCOUNT_SID_2, token: process.env.TWILIO_AUTH_TOKEN_2 },
  { etichetta: 'slot 3', sid: process.env.TWILIO_ACCOUNT_SID_3, token: process.env.TWILIO_AUTH_TOKEN_3 },
];
const API = 'https://content.twilio.com/v1/Content';
const invia = process.argv.includes('--invia');
const soloStato = process.argv.includes('--stato');

async function trovaPerNome(auth: string, NAME: string): Promise<string | null> {
  let url: string | null = `${API}?PageSize=50`;
  while (url) {
    const r: Response = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`LIST ${r.status}`);
    const j: any = await r.json();
    const c = (j.contents ?? []).find((x: any) => x.friendly_name === NAME);
    if (c) return String(c.sid);
    url = j.meta?.next_page_url ?? null;
  }
  return null;
}

async function stato(sid: string, auth: string): Promise<string> {
  const r = await fetch(`${API}/${sid}/ApprovalRequests`, { headers: { Authorization: auth } });
  const j: any = await r.json();
  return j?.whatsapp ? `${j.whatsapp.status} (${j.whatsapp.category})${j.whatsapp.rejection_reason ? ` - ${j.whatsapp.rejection_reason}` : ''}` : 'nessuna richiesta';
}

for (const t of TEMPLATE) console.log(`nome:  ${t.nome}\n${t.descr}\n`);
if (!invia && !soloStato) {
  console.log('Prova: nessun invio. --invia per creare e chiedere l\'approvazione UTILITY, --stato per lo stato.');
  process.exit(0);
}

for (const a of ACCOUNT) {
  if (!a.sid || !a.token || a.sid.includes('SENSITIVE') || a.token.includes('SENSITIVE')) {
    console.log(`[${a.etichetta}] credenziali mancanti o mascherate: SALTATO`);
    continue;
  }
  const auth = 'Basic ' + Buffer.from(`${a.sid}:${a.token}`).toString('base64');
  for (const t of TEMPLATE) {
    const NAME = t.nome;
    try {
      let sid = await trovaPerNome(auth, NAME);
      if (soloStato) { console.log(`[${a.etichetta}] ${NAME}: ${sid ?? 'non esiste'}${sid ? ` ${await stato(sid, auth)}` : ''}`); continue; }
      if (sid) {
        console.log(`[${a.etichetta}] ${NAME} esiste gia': ${sid}`);
      } else {
        const r = await fetch(API, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendly_name: NAME, language: 'it', variables: t.variabili, types: t.types }),
        });
        const j: any = await r.json();
        if (!r.ok) throw new Error(`CREATE ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
        sid = String(j.sid);
        console.log(`[${a.etichetta}] ${NAME} creato: ${sid}`);
      }
      const prima = await stato(sid, auth);
      if (prima === 'nessuna richiesta' || prima.startsWith('unsubmitted')) {
        const r = await fetch(`${API}/${sid}/ApprovalRequests/whatsapp`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: NAME, category: 'UTILITY' }),
        });
        if (!r.ok) throw new Error(`APPROVAL ${r.status}: ${(await r.text()).slice(0, 300)}`);
      }
      console.log(`[${a.etichetta}] ${NAME} approvazione: ${await stato(sid, auth)}`);
    } catch (e) {
      console.log(`[${a.etichetta}] ${NAME} ERRORE: ${(e as Error).message}`);
    }
  }
}
