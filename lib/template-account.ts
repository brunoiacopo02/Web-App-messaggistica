/**
 * Lo stesso template, sull'account che possiede il numero mittente.
 *
 * Un Content template vive DENTRO un account Twilio: lo stesso messaggio
 * esiste sui due account con SID diversi. Tutte le env `*_TEMPLATE_SID` del
 * progetto contengono i SID dell'account storico; usarli per mandare dal numero
 * del secondo account significa chiedere un template che quell'account non ha —
 * Twilio risponde 404, e con `UTILITY_ONLY=1` il presidio fallisce chiuso ancora
 * prima, in `getTemplateCategory`.
 *
 * L'aggancio e' il **friendly_name**: i 38 template del secondo account sono
 * stati creati copiando quelli del primo e portano gli stessi nomi
 * (`fenice_agenda_gdo_v3`, `fenice_open_c1_marta_v1`, …). Il nome e' l'unica
 * cosa che i due account condividono, ed e' per questo che si traduce di li'.
 *
 * Perche' a runtime e non una mappa nelle env: i nomi sono trentotto e
 * cambiano quando si pubblica una versione nuova. Una mappa scritta a mano
 * sarebbe giusta il giorno che la scrivi e sbagliata la settimana dopo, e
 * sbagliata qui vuol dire un messaggio che non parte.
 *
 * In caso di dubbio si torna il SID originale: un 404 su un template si vede
 * subito nei log, mentre indovinare il template sbagliato manderebbe al lead un
 * messaggio che non era quello previsto.
 */

import { credenzialiPerMittente, eDelSecondoAccount } from './twilio-account';

/** SID di partenza → SID sull'account del mittente. Chiave: `${accountSid}:${sidOriginale}`. */
const _cache = new Map<string, string>();
/** friendly_name → SID, per account. Si ripopola alla prima traduzione. */
const _perAccount = new Map<string, Map<string, string>>();

async function get(url: string, sid: string, token: string): Promise<any | null> {
    const r = await fetch(url, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
    });
    if (!r.ok) return null;
    return r.json();
}

/**
 * Il suffisso delle copie rifatte per ottenere la categoria UTILITY.
 *
 * Un template gia' sottomesso a Meta non si puo' ricategorizzare: Twilio
 * risponde 92009 "recreate a new template to make any changes". L'unica strada
 * e' crearne uno nuovo — e il nome, sull'account, dev'essere diverso.
 */
const SUFFISSO_UTILITY = '_u';

/** Un template e' approvato da Meta come UTILITY? */
async function approvatoUtility(contentSid: string, sid: string, token: string): Promise<boolean> {
    const j = await get(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, sid, token);
    const w = j?.whatsapp;
    return w?.status === 'approved' && w?.category === 'UTILITY';
}

/** Tutti i template di un account, per nome. Una sola chiamata, poi in cache. */
async function indicePerNome(sid: string, token: string): Promise<Map<string, string>> {
    const gia = _perAccount.get(sid);
    if (gia) return gia;

    const indice = new Map<string, string>();
    let url: string | null = 'https://content.twilio.com/v1/Content?PageSize=50';
    while (url) {
        const j: any = await get(url, sid, token);
        if (!j) break;
        for (const c of j.contents ?? []) {
            if (c?.friendly_name && c?.sid) indice.set(String(c.friendly_name), String(c.sid));
        }
        url = j.meta?.next_page_url ?? null;
    }

    // Se esiste la copia `<nome>_u`, la si preferisce all'originale — ma SOLO se
    // Meta l'ha gia' approvata come UTILITY. Finche' e' in attesa si continua a
    // usare quella di prima: preferire un template non approvato vorrebbe dire
    // smettere di mandare proprio i messaggi che stiamo cercando di sistemare.
    // Il controllo costa una chiamata per copia, una volta per processo.
    for (const [nome, sidCopia] of [...indice]) {
        if (!nome.endsWith(SUFFISSO_UTILITY)) continue;
        const base = nome.slice(0, -SUFFISSO_UTILITY.length);
        if (!indice.has(base)) continue;
        if (await approvatoUtility(sidCopia, sid, token)) indice.set(base, sidCopia);
    }
    // Un indice VUOTO non si mette in cache. Prima si faceva, per non ripetere
    // una chiamata di rete destinata a fallire; ma l'effetto vero era peggiore:
    // se l'API rispondeva male una volta sola, quell'istanza restava avvelenata
    // per tutta la sua vita e faceva fallire OGNI invio successivo dal secondo
    // numero. Il 17/09/2026 i fallimenti arrivavano infatti a grappoli di
    // minuti consecutivi, cioe' esattamente la firma di un'istanza avvelenata.
    // Un indice pieno invece si mette in cache: quello e' un risultato buono.
    if (indice.size > 0) _perAccount.set(sid, indice);
    return indice;
}

/**
 * Il SID da usare per mandare `contentSid` DA `from`.
 *
 * Se `from` sta sull'account storico (o non e' mappato) torna il SID originale
 * senza toccare la rete: e' il caso normale, e non deve costare niente.
 */
/** Esito della traduzione: il SID da usare, e se si e' potuto tradurre davvero. */
export interface TraduzioneTemplate {
    sid: string;
    /**
     * false = il template non esiste sull'account del mittente (o non si e'
     * potuto verificare). Il SID tornato e' quello di partenza, che da quel
     * numero NON partira': chi chiama deve decidere cosa fare invece di
     * mandarlo e basta.
     */
    tradotto: boolean;
}

/**
 * Come `templatePerMittente`, ma dice anche se la traduzione e' riuscita.
 *
 * Serve perche' "non sono riuscito a tradurre" e "non c'era niente da tradurre"
 * portavano entrambe allo stesso valore di ritorno, e il chiamante non poteva
 * distinguerle: mandava il SID dell'altro account e il messaggio moriva.
 */
export async function traduciTemplate(contentSid: string, from?: string | null): Promise<TraduzioneTemplate> {
    if (!eDelSecondoAccount(from)) return { sid: contentSid, tradotto: true };

    const dest = credenzialiPerMittente(from);
    if (!dest) return { sid: contentSid, tradotto: true };

    // Stesso account di partenza: non c'e' niente da tradurre. Succede quando
    // il numero e' dichiarato del secondo account ma le sue credenziali non ci
    // sono, e `credenzialiPerMittente` ripiega sul principale. Senza questa
    // riga si andrebbe a cercare il SID sull'account che gia' lo possiede.
    if (dest.sid === process.env.TWILIO_ACCOUNT_SID) return { sid: contentSid, tradotto: true };

    const chiave = `${dest.sid}:${contentSid}`;
    const inCache = _cache.get(chiave);
    if (inCache) return { sid: inCache, tradotto: true };

    const origine = {
        sid: process.env.TWILIO_ACCOUNT_SID ?? '',
        token: process.env.TWILIO_AUTH_TOKEN ?? '',
    };
    if (!origine.sid || !origine.token) return { sid: contentSid, tradotto: false };

    // Il nome del template si chiede all'account che LO possiede.
    const c = await get(`https://content.twilio.com/v1/Content/${contentSid}`, origine.sid, origine.token);
    const nome = c?.friendly_name ? String(c.friendly_name) : null;
    if (!nome) {
        console.error(`[template-account] ${contentSid} non leggibile sull'account di origine: uso il SID originale`);
        return { sid: contentSid, tradotto: false };
    }

    const indice = await indicePerNome(dest.sid, dest.token);
    const tradotto = indice.get(nome);
    if (!tradotto) {
        console.error(
            `[template-account] "${nome}" non esiste sull'account ${dest.sid}: il messaggio da ${from} fallira'. ` +
            'Va creato e approvato anche li.',
        );
        return { sid: contentSid, tradotto: false };
    }

    _cache.set(chiave, tradotto);
    return { sid: tradotto, tradotto: true };
}

/**
 * Il SID da usare per mandare `contentSid` DA `from`, senza dire se e' stato
 * tradotto. Resta per chi quella distinzione non la usa.
 */
export async function templatePerMittente(contentSid: string, from?: string | null): Promise<string> {
    return (await traduciTemplate(contentSid, from)).sid;
}

/** Svuota le cache. Serve ai test, non al codice di produzione. */
export function _svuotaCacheTemplate(): void {
    _cache.clear();
    _perAccount.clear();
}
