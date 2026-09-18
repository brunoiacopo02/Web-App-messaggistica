import { NextResponse } from 'next/server';
import { credenzialiPerMittente } from '@/lib/twilio-account';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Referto e manutenzione del secondo numero WhatsApp.
 *
 * Esiste perche' le credenziali del secondo account Twilio sono segnate come
 * "sensitive" su Vercel: `vercel env pull` le scrive come `[SENSITIVE]`, quindi
 * da fuori non si possono usare. Qui dentro invece le env sono quelle vere.
 *
 * Non ha una sessione utente ma un segreto suo (`ADMIN_TOOLS_SECRET`): serve a
 * poterlo chiamare senza passare da un browser loggato, ed e' scrivibile anche
 * da chi non puo' rileggere le altre env.
 *
 * `modo`:
 *   - `referto`      (default) sola lettura: qualita' dei mittenti sui due
 *                    account, e i template che sono UTILITY sull'account
 *                    storico ma MARKETING su quello nuovo.
 *   - `risottoponi`  prova a rimandare a Meta la richiesta di approvazione come
 *                    UTILITY per quei template. Con `nome` ne fa uno solo.
 */

type Cred = { sid: string; token: string };

function auth(c: Cred) {
    return 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64');
}

async function chiedi(url: string, c: Cred): Promise<any | null> {
    const r = await fetch(url, { headers: { Authorization: auth(c) } });
    if (!r.ok) return null;
    return r.json();
}

/** Tutti i template di un account: nome -> sid. */
async function templatePerNome(c: Cred): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    let url: string | null = 'https://content.twilio.com/v1/Content?PageSize=50';
    while (url) {
        const j: any = await chiedi(url, c);
        if (!j) break;
        for (const x of j.contents ?? []) {
            if (x?.friendly_name && x?.sid) m.set(String(x.friendly_name), String(x.sid));
        }
        url = j.meta?.next_page_url ?? null;
    }
    return m;
}

async function categoria(sid: string, c: Cred): Promise<string | null> {
    const j = await chiedi(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, c);
    return j?.whatsapp?.category ?? null;
}

async function mittenti(c: Cred) {
    const j = await chiedi('https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50', c);
    return (j?.senders ?? []).map((s: any) => ({
        numero: s.sender_id,
        stato: s.status,
        qualita: s.properties?.quality_rating ?? null,
        limite: s.properties?.messaging_limit ?? null,
    }));
}

function credenziali(): { primo: Cred | null; secondo: Cred | null } {
    const primo = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
        ? { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN } : null;
    // Si passa dal numero del secondo account, cosi' la mappatura resta una sola
    // (quella di twilio-account.ts) e non se ne inventa un'altra qui.
    const unNumeroDelSecondo = (process.env.TWILIO_WHATSAPP_NUMBERS_2 ?? '').split(',')[0]?.trim();
    const secondo = unNumeroDelSecondo ? credenzialiPerMittente(unNumeroDelSecondo) : null;
    // Se ripiega sul principale vuol dire che il secondo non e' configurato.
    return { primo, secondo: secondo && secondo.sid !== primo?.sid ? secondo : null };
}

/** I template UTILITY sull'account storico e MARKETING su quello nuovo. */
async function disallineati(primo: Cred, secondo: Cred) {
    const [n1, n2] = await Promise.all([templatePerNome(primo), templatePerNome(secondo)]);
    const fuori: Array<{ nome: string; sidPrimo: string; catPrimo: string | null; sidSecondo: string; catSecondo: string | null }> = [];
    const soloSulPrimo: string[] = [];
    for (const [nome, sidPrimo] of n1) {
        const sidSecondo = n2.get(nome);
        if (!sidSecondo) { soloSulPrimo.push(nome); continue; }
        const [catPrimo, catSecondo] = await Promise.all([
            categoria(sidPrimo, primo), categoria(sidSecondo, secondo),
        ]);
        if (catPrimo === 'UTILITY' && catSecondo !== 'UTILITY') {
            fuori.push({ nome, sidPrimo, catPrimo, sidSecondo, catSecondo });
        }
    }
    return { fuori, soloSulPrimo, totalePrimo: n1.size, totaleSecondo: n2.size };
}

/**
 * Le env che contengono un SID di template. Elencate a mano e non dedotte:
 * questo referto serve a scoprire cosa manca sul secondo account, e una env
 * dimenticata qui vorrebbe dire un template che sembra a posto e non lo e'.
 */
const ENV_TEMPLATE = [
    'AGENDA_GDO_TEMPLATE_SID', 'AGENDA_TEMPLATE_SID', 'FENICE_OPENING_TEMPLATE_SID',
    'LANCIO_FOLLOWUP_TEMPLATE_SID', 'LANCIO_WELCOME_TEMPLATE_SID', 'LANCIO_ZOOM_TEMPLATE_SID',
    'MARTA_REENGAGE_TEMPLATE_SID', 'NR1_TEMPLATE_SID', 'NR3_TEMPLATE_SID',
    'REMINDER_24H_NOVIDEO_TEMPLATE_SID', 'REMINDER_24H_TEMPLATE_SID', 'REMINDER_3H_TEMPLATE_SID',
    'SEQ_TEMPLATE_SID_1', 'SEQ_TEMPLATE_SID_2', 'SEQ_TEMPLATE_SID_3', 'SEQ_TEMPLATE_SID_4',
    'VIDEO_TEMPLATE_SID',
] as const;

type Usato = {
    env: string; sid: string; nome: string | null;
    catPrimo: string | null; suSecondo: string | null; catSecondo: string | null;
};

/**
 * Per ogni template che il codice usa davvero: come sta sull'account storico e
 * come sta su quello nuovo. Un template che il bot manda e che di la' non
 * esiste e' un messaggio che dal numero nuovo non puo' partire.
 */
async function templateUsati(primo: Cred, secondo: Cred): Promise<Usato[]> {
    const n1 = await templatePerNome(primo);
    const n2 = await templatePerNome(secondo);
    const perSid = new Map([...n1].map(([nome, sid]) => [sid, nome]));

    const out: Usato[] = [];
    for (const env of ENV_TEMPLATE) {
        const sid = process.env[env]?.trim();
        if (!sid) continue;
        const nome = perSid.get(sid) ?? null;
        const sidSecondo = nome ? n2.get(nome) ?? null : null;
        out.push({
            env, sid, nome,
            catPrimo: nome ? await categoria(sid, primo) : null,
            suSecondo: sidSecondo,
            catSecondo: sidSecondo ? await categoria(sidSecondo, secondo) : null,
        });
    }
    return out;
}

export async function GET(req: Request) {
    const segreto = process.env.ADMIN_TOOLS_SECRET;
    if (!segreto || req.headers.get('authorization') !== `Bearer ${segreto}`) {
        return new NextResponse('Unauthorized', { status: 401 });
    }
    const { primo, secondo } = credenziali();
    if (!primo) return NextResponse.json({ ok: false, error: 'credenziali account storico assenti' }, { status: 500 });
    if (!secondo) return NextResponse.json({ ok: false, error: 'secondo account non configurato' }, { status: 500 });

    const modo = new URL(req.url).searchParams.get('modo');
    if (modo === 'usati') {
        return NextResponse.json({ ok: true, usati: await templateUsati(primo, secondo) });
    }

    const [qualitaPrimo, qualitaSecondo, cat] = await Promise.all([
        mittenti(primo), mittenti(secondo), disallineati(primo, secondo),
    ]);
    return NextResponse.json({ ok: true, qualitaPrimo, qualitaSecondo, ...cat });
}

export async function POST(req: Request) {
    const segreto = process.env.ADMIN_TOOLS_SECRET;
    if (!segreto || req.headers.get('authorization') !== `Bearer ${segreto}`) {
        return new NextResponse('Unauthorized', { status: 401 });
    }
    let corpo: { nome?: string; modo?: string; nomi?: string[] } = {};
    try { corpo = await req.json(); } catch { /* corpo vuoto = tutti */ }

    const { primo, secondo } = credenziali();
    if (!primo || !secondo) return NextResponse.json({ ok: false, error: 'account non configurati' }, { status: 500 });

    // Crea sul secondo account i template che il codice usa e che di la' non
    // esistono. La categoria richiesta e' QUELLA DELL'ORIGINALE, non UTILITY a
    // prescindere: le aperture sono MARKETING anche sull'account storico, e
    // chiedere per loro una categoria che non hanno sarebbe una richiesta
    // sbagliata che Meta rifiuterebbe o, peggio, accoglierebbe.
    if (corpo.modo === 'crea-mancanti') {
        const usati = await templateUsati(primo, secondo);
        // `nomi` e' obbligatorio: fra i mancanti c'e' anche roba di un'altra
        // azienda (`agendaserenamente`), che sull'account Fenice non ci deve
        // stare. Si crea solo quello che si e' guardato e scelto.
        if (!Array.isArray(corpo.nomi) || corpo.nomi.length === 0) {
            return NextResponse.json({
                ok: false,
                error: 'servono i nomi da creare',
                mancanti: usati.filter((u) => u.nome && !u.suSecondo).map((u) => u.nome),
            }, { status: 400 });
        }
        const scelti = new Set(corpo.nomi);
        const mancanti = usati.filter((u) => u.nome && !u.suSecondo && scelti.has(u.nome));
        const esiti: Array<{ nome: string; passo: string; http: number; risposta: string }> = [];
        for (const u of mancanti) {
            const originale = await chiedi(`https://content.twilio.com/v1/Content/${u.sid}`, primo);
            if (!originale?.types) {
                esiti.push({ nome: u.nome!, passo: 'lettura originale', http: 0, risposta: 'non leggibile' });
                continue;
            }
            const creaRes = await fetch('https://content.twilio.com/v1/Content', {
                method: 'POST',
                headers: { Authorization: auth(secondo), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    friendly_name: u.nome,
                    language: originale.language ?? 'it',
                    variables: originale.variables ?? {},
                    types: originale.types,
                }),
            });
            const creato = await creaRes.json().catch(() => null);
            if (!creaRes.ok || !creato?.sid) {
                esiti.push({ nome: u.nome!, passo: 'creazione', http: creaRes.status, risposta: JSON.stringify(creato).slice(0, 300) });
                continue;
            }
            const appr = await fetch(`https://content.twilio.com/v1/Content/${creato.sid}/ApprovalRequests/whatsapp`, {
                method: 'POST',
                headers: { Authorization: auth(secondo), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: u.nome, category: u.catPrimo ?? 'UTILITY' }),
            });
            esiti.push({ nome: u.nome!, passo: `richiesta ${u.catPrimo ?? 'UTILITY'}`, http: appr.status, risposta: (await appr.text()).slice(0, 300) });
        }
        return NextResponse.json({ ok: true, tentati: mancanti.length, esiti });
    }

    const { fuori } = await disallineati(primo, secondo);
    const daFare = corpo.nome ? fuori.filter((f) => f.nome === corpo.nome) : fuori;

    const esiti: Array<{ nome: string; passo: string; http: number; risposta: string }> = [];
    for (const f of daFare) {
        if (corpo.modo === 'ricrea') {
            // Un template gia' sottomesso non si ricategorizza (Twilio 92009):
            // se ne crea uno NUOVO con lo stesso testo e si chiede UTILITY. Il
            // nome dev'essere diverso, da qui il suffisso `_u`; il codice lo
            // preferisce da solo appena Meta l'ha approvato (template-account.ts),
            // quindi finche' e' in attesa non cambia niente.
            const originale = await chiedi(`https://content.twilio.com/v1/Content/${f.sidPrimo}`, primo);
            if (!originale?.types) {
                esiti.push({ nome: f.nome, passo: 'lettura originale', http: 0, risposta: 'non leggibile' });
                continue;
            }
            const nuovoNome = `${f.nome}_u`;
            const creaRes = await fetch('https://content.twilio.com/v1/Content', {
                method: 'POST',
                headers: { Authorization: auth(secondo), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    friendly_name: nuovoNome,
                    language: originale.language ?? 'it',
                    variables: originale.variables ?? {},
                    types: originale.types,
                }),
            });
            const creato = await creaRes.json().catch(() => null);
            if (!creaRes.ok || !creato?.sid) {
                esiti.push({ nome: nuovoNome, passo: 'creazione', http: creaRes.status, risposta: JSON.stringify(creato).slice(0, 300) });
                continue;
            }
            const appr = await fetch(`https://content.twilio.com/v1/Content/${creato.sid}/ApprovalRequests/whatsapp`, {
                method: 'POST',
                headers: { Authorization: auth(secondo), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: nuovoNome, category: 'UTILITY' }),
            });
            const testoAppr = await appr.text();
            esiti.push({ nome: nuovoNome, passo: 'richiesta UTILITY', http: appr.status, risposta: testoAppr.slice(0, 300) });
            continue;
        }

        const r = await fetch(`https://content.twilio.com/v1/Content/${f.sidSecondo}/ApprovalRequests/whatsapp`, {
            method: 'POST',
            headers: { Authorization: auth(secondo), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: f.nome, category: 'UTILITY' }),
        });
        const testo = await r.text();
        esiti.push({ nome: f.nome, passo: 'risottomissione', http: r.status, risposta: testo.slice(0, 300) });
    }
    return NextResponse.json({ ok: true, tentati: daFare.length, esiti });
}
