import { mondoDi } from '@/lib/chat-perimetro';
import { LANCIO_FASI_TERMINALI, isLancioFase, type LancioFase } from '@/lib/lancio-fase';

export const VISTE = ['serve_te', 'non_lette', 'lancio', 'fissati_bot', 'gdo', 'mario', 'chiuse', 'campagne', 'errori'] as const;
export type Vista = (typeof VISTE)[number];

export const VISTA_META: Record<Vista, { etichetta: string; urgente: boolean; gruppo: 'priorita' | 'lancio' | 'mondi' | 'sistema' }> = {
  serve_te: { etichetta: 'Serve te', urgente: true, gruppo: 'priorita' },
  non_lette: { etichetta: 'Non lette', urgente: false, gruppo: 'priorita' },
  errori: { etichetta: 'Con errori', urgente: true, gruppo: 'priorita' },
  lancio: { etichetta: 'Lancio', urgente: false, gruppo: 'lancio' },
  fissati_bot: { etichetta: 'Fissati dal bot', urgente: false, gruppo: 'mondi' },
  mario: { etichetta: 'Mario in corso', urgente: false, gruppo: 'mondi' },
  gdo: { etichetta: 'Lead dei GDO', urgente: false, gruppo: 'mondi' },
  campagne: { etichetta: 'Campagne', urgente: false, gruppo: 'mondi' },
  chiuse: { etichetta: 'Chiuse e restituite', urgente: false, gruppo: 'mondi' },
};

export const ETICHETTA_FASE: Record<LancioFase, string> = {
  attesa: 'In attesa', posto_bloccato: 'Posto bloccato', link_inviato: 'Link inviato',
  post_pitch: 'Dopo il pitch', scelta_fatta: 'Scelta fatta', followup_inviato: 'Follow-up inviato',
  restituito: 'Restituito', chiuso: 'Chiuso',
};

export type RigaVista = {
  id: number; ai_owner: string | null; ai_status: string | null; ai_paused_at: string | null;
  bot_outcome: string | null; gdo_agenda_at: string | null; gdo_video_sent_at: string | null;
  campaign_id: number | null; lancio_slug: string | null; lancio_fase: string | null;
  last_inbound_at: string | null; unread_count: number | null;
};
export type CtxVista = { now: Date; conErrori: ReadonlySet<number> };

const SETTE_GIORNI = 7 * 24 * 3600_000;
/** Tetto degli id nel filtro `in()` della vista "Con errori" (lunghezza dell'URL PostgREST). */
export const MAX_ID_ERRORI = 200;
const ESITI_CHIUSI = ['DA_SCARTARE', 'NON_RISPOSTO', 'INTERROTTO', 'RICHIAMO'];

export function isVista(x: unknown): x is Vista {
  return typeof x === 'string' && (VISTE as readonly string[]).includes(x);
}

const recente = (iso: string | null, now: Date) => !!iso && now.getTime() - Date.parse(iso) <= SETTE_GIORNI;

export function inVista(r: RigaVista, v: Vista, ctx: CtxVista): boolean {
  switch (v) {
    case 'serve_te':
      return r.ai_paused_at != null
        || ((r.ai_status === 'handed_off' || r.bot_outcome === 'CONTATTO_UMANO') && recente(r.last_inbound_at, ctx.now));
    case 'non_lette': return (r.unread_count ?? 0) > 0;
    case 'lancio': return r.lancio_slug != null;
    case 'fissati_bot': return r.bot_outcome === 'APPUNTAMENTO';
    case 'gdo': return mondoDi(r) === 'GDO';
    case 'campagne':
      // ai_owner è sempre 'mario' o null (vedi lib/chat-perimetro.ts)
      return mondoDi(r) === 'CAMPAGNA';
    case 'mario':
      // ai_owner è sempre 'mario' o null (vedi lib/chat-perimetro.ts)
      return r.ai_owner === 'mario' && r.gdo_agenda_at == null && r.bot_outcome == null
        && (r.ai_status == null || r.ai_status === 'active' || r.ai_status === 'replying')
        && (r.lancio_fase == null || !(LANCIO_FASI_TERMINALI as readonly string[]).includes(r.lancio_fase));
    case 'chiuse':
      return r.ai_status === 'closed' || (r.lancio_fase != null && (LANCIO_FASI_TERMINALI as readonly string[]).includes(r.lancio_fase))
        || (r.bot_outcome != null && ESITI_CHIUSI.includes(r.bot_outcome));
    case 'errori': return ctx.conErrori.has(r.id);
  }
}

// Il query builder di supabase-js non si presta a un generic stretto (vedi lib/chat-perimetro.ts).
export function applicaVista<Q>(q: Q, v: Vista, ctx: { now: Date; conErrori: readonly number[] }): Q | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x = q as any;
  const da7 = new Date(ctx.now.getTime() - SETTE_GIORNI).toISOString();
  switch (v) {
    case 'serve_te':
      return x.or(`ai_paused_at.not.is.null,and(ai_status.eq.handed_off,last_inbound_at.gte.${da7}),and(bot_outcome.eq.CONTATTO_UMANO,last_inbound_at.gte.${da7})`);
    case 'non_lette': return x.gt('unread_count', 0);
    case 'lancio': return x.not('lancio_slug', 'is', null);
    case 'fissati_bot': return x.eq('bot_outcome', 'APPUNTAMENTO');
    case 'gdo': return x.or('gdo_agenda_at.not.is.null,and(gdo_video_sent_at.not.is.null,ai_owner.is.null)');
    case 'campagne': return x.is('ai_owner', null).is('gdo_agenda_at', null).is('gdo_video_sent_at', null);
    case 'mario':
      return x.eq('ai_owner', 'mario').is('gdo_agenda_at', null).is('bot_outcome', null)
        .or('ai_status.is.null,ai_status.in.(active,replying)')
        .or(`lancio_fase.is.null,lancio_fase.not.in.(${LANCIO_FASI_TERMINALI.join(',')})`);
    case 'chiuse':
      return x.or(`ai_status.eq.closed,lancio_fase.in.(${LANCIO_FASI_TERMINALI.join(',')}),bot_outcome.in.(${ESITI_CHIUSI.join(',')})`);
    case 'errori':
      // Oltre 200 chat la vista mostra le 200 con il fallimento più recente (`idsConErrori` le
      // ordina così): un solo filtro `in()`, compatibile con il cursore della lista e con il conteggio.
      return ctx.conErrori.length === 0 ? null : x.in('id', ctx.conErrori.slice(0, MAX_ID_ERRORI));
  }
}

export function contestoRiga(r: RigaVista, ctx: CtxVista): { testo: string; tono: 'urgente' | 'errore' | 'neutro' | 'onda' } | null {
  if (inVista(r, 'serve_te', ctx)) return { testo: 'Serve te', tono: 'urgente' };
  if (ctx.conErrori.has(r.id)) return { testo: 'Invio non riuscito', tono: 'errore' };
  if (r.bot_outcome === 'APPUNTAMENTO') return { testo: 'Fissato dal bot', tono: 'neutro' };
  if (r.lancio_slug) return { testo: (isLancioFase(r.lancio_fase) ? ETICHETTA_FASE[r.lancio_fase] : 'Lancio'), tono: 'onda' };
  const m = mondoDi(r);
  if (m === 'GDO') return { testo: 'Lead GDO', tono: 'neutro' };
  if (m === 'CAMPAGNA') return { testo: 'Campagna', tono: 'neutro' };
  if (inVista(r, 'mario', ctx)) return { testo: 'Mario in corso', tono: 'neutro' };
  return null;
}
