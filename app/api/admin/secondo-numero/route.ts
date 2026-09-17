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

export async function GET(req: Request) {
    const segreto = process.env.ADMIN_TOOLS_SECRET;
    if (!segreto || req.headers.get('authorization') !== `Bearer ${segreto}`) {
        return new NextResponse('Unauthorized', { status: 401 });
    }
    const { primo, secondo } = credenziali();
    if (!primo) return NextResponse.json({ ok: false, error: 'credenziali account storico assenti' }, { status: 500 });
    if (!secondo) return NextResponse.json({ ok: false, error: 'secondo account non configurato' }, { status: 500 });

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
    let corpo: { nome?: string } = {};
    try { corpo = await req.json(); } catch { /* corpo vuoto = tutti */ }

    const { primo, secondo } = credenziali();
    if (!primo || !secondo) return NextResponse.json({ ok: false, error: 'account non configurati' }, { status: 500 });

    const { fuori } = await disallineati(primo, secondo);
    const daFare = corpo.nome ? fuori.filter((f) => f.nome === corpo.nome) : fuori;

    const esiti: Array<{ nome: string; http: number; risposta: string }> = [];
    for (const f of daFare) {
        const r = await fetch(`https://content.twilio.com/v1/Content/${f.sidSecondo}/ApprovalRequests/whatsapp`, {
            method: 'POST',
            headers: { Authorization: auth(secondo), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: f.nome, category: 'UTILITY' }),
        });
        const testo = await r.text();
        esiti.push({ nome: f.nome, http: r.status, risposta: testo.slice(0, 300) });
    }
    return NextResponse.json({ ok: true, tentati: daFare.length, esiti });
}
