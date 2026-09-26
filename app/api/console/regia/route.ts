import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { richiediAdmin } from '@/lib/console/guardia';
import { fotografia, consegne } from '@/lib/lancio-monitor-db';
import { calcolaContatori } from '@/lib/lancio-monitor';
import { consegnePerOra, inizioGiornoRoma, scalettaDa, statoOnda, type Regia } from '@/lib/console/regia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Supa = ReturnType<typeof getSupabaseAdmin>;
type MsgOggi = { created_at: string; twilio_status: string | null };

/** Gli invii di oggi (ora di Roma), riusati per 20 s come la fotografia: più schede aperte
 *  non rileggono migliaia di righe a ogni giro di polling. Un errore non resta in cache. */
const TTL = 20_000;
let cacheOggi: { at: number; da: string; p: Promise<MsgOggi[]> } | null = null;
function messaggiDiOggi(s: Supa, now: Date): Promise<MsgOggi[]> {
  const da = inizioGiornoRoma(now).toISOString();
  if (cacheOggi && cacheOggi.da === da && now.getTime() - cacheOggi.at < TTL) return cacheOggi.p;
  const p = fetchAllRows<MsgOggi>(
    (a, b) =>
      s
        .from('messages')
        .select('created_at, twilio_status')
        .eq('direction', 'out')
        .gte('created_at', da)
        .order('id', { ascending: true })
        .range(a, b) as never,
    { max: 50_000 },
  );
  cacheOggi = { at: now.getTime(), da, p };
  p.catch(() => {
    if (cacheOggi?.p === p) cacheOggi = null;
  });
  return p;
}

const ZERO: Regia['numeri'] = { iscritti: 0, postoBloccato: 0, linkInviati: 0, consegnatiOggi: 0, fallitiOggi: 0 };

export async function GET() {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const now = new Date();
  const s = getSupabaseAdmin();
  try {
    const foto = await fotografia(s, now);
    const { attivo, eventoAt } = foto.settings;
    if (!attivo) {
      const spento: Regia = {
        attivo: false,
        eventoAt,
        stato: { stato: 'nessuno', secondi: 0 },
        scaletta: [],
        numeri: ZERO,
        perFase: {},
        perOra: consegnePerOra([]),
        generatoAt: now.toISOString(),
      };
      return NextResponse.json(spento);
    }

    const [cons, oggi] = await Promise.all([
      // Le consegne per template sono un di più: se la lettura cade, i contatori restano.
      consegne(s, foto, now).catch(() => null),
      messaggiDiOggi(s, now),
    ]);
    const contatori = calcolaContatori(foto.chats, foto.eventiContatori, cons?.consegne ?? null, foto.colonnaInizio);
    const perOra = consegnePerOra(oggi);
    const regia: Regia = {
      attivo: true,
      eventoAt,
      stato: statoOnda(now, eventoAt),
      scaletta: scalettaDa(eventoAt),
      numeri: {
        iscritti: contatori.iscritti,
        postoBloccato: contatori.postoBloccato,
        linkInviati: contatori.linkZoomInviati,
        consegnatiOggi: perOra.reduce((n, o) => n + o.consegnati, 0),
        fallitiOggi: perOra.reduce((n, o) => n + o.falliti, 0),
      },
      perFase: contatori.perFase,
      perOra,
      generatoAt: now.toISOString(),
    };
    return NextResponse.json(regia);
  } catch (e) {
    return NextResponse.json({ error: 'lettura_fallita', dettaglio: (e as Error).message }, { status: 500 });
  }
}
