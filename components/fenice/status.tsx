import { cn } from '@/lib/utils';

/**
 * Single source of truth for every state label the Fenice panel shows.
 * The bot pipeline speaks in three overlapping vocabularies — chat status,
 * lead segment, and "ferma" reason / outcome. Mapping them all here keeps the
 * UI consistent: same word, same colour, everywhere.
 */

export type Tone = 'ember' | 'emerald' | 'sky' | 'amber' | 'rose' | 'violet' | 'zinc';

const TONE_PILL: Record<Tone, string> = {
  ember: 'border-brand/30 bg-brand/12 text-brand',
  emerald: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  sky: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  amber: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300',
  rose: 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  violet: 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  zinc: 'border-border bg-muted text-muted-foreground',
};

const TONE_DOT: Record<Tone, string> = {
  ember: 'bg-brand',
  emerald: 'bg-emerald-500',
  sky: 'bg-sky-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  violet: 'bg-violet-500',
  zinc: 'bg-muted-foreground',
};

type Meta = { label: string; tone: Tone; hint: string };

/** Chat-level status used by the live table and conversation list. */
export function chatStatusMeta(status: string | null): Meta {
  switch (status) {
    case 'booked':
      return { label: 'Appuntamento', tone: 'emerald', hint: 'Mario ha fissato un appuntamento.' };
    case 'handed_off':
      return { label: 'A operatore', tone: 'rose', hint: 'Passato a un umano: serve intervento.' };
    default:
      return { label: 'Attivo', tone: 'sky', hint: 'Conversazione in corso, gestita da Mario.' };
  }
}

/** Pipeline segment shown in the Lead view. */
export function segmentMeta(segment: string): Meta {
  switch (segment) {
    case 'PRESO':
      return { label: 'Preso', tone: 'emerald', hint: 'Appuntamento fissato.' };
    case 'ATTIVA':
      return { label: 'Attiva', tone: 'sky', hint: 'Ha risposto di recente, conversazione viva.' };
    case 'MAI_RISPOSTO':
      return { label: 'Mai risposto', tone: 'zinc', hint: 'Apertura inviata, nessuna risposta.' };
    case 'FERMA':
      return { label: 'Ferma', tone: 'amber', hint: 'Conversazione bloccata: vedi il motivo.' };
    default:
      return { label: segment, tone: 'zinc', hint: '' };
  }
}

/** Reason a "ferma" lead is stuck, or the final bot outcome. */
export function reasonMeta(reason: string | null): Meta | null {
  if (!reason) return null;
  switch (reason) {
    case 'APPUNTAMENTO':
      return { label: 'Appuntamento', tone: 'emerald', hint: 'Obiettivo raggiunto.' };
    case 'RICHIAMO':
      return { label: 'Da richiamare', tone: 'amber', hint: 'Interessato ma da ricontattare a voce.' };
    case 'DA_SCARTARE':
      return { label: 'Da scartare', tone: 'rose', hint: 'Non in target o non interessato.' };
    case 'INTERROTTO':
      return { label: 'Interrotto', tone: 'violet', hint: 'Aveva risposto, poi è sparito: recuperabile.' };
    case 'NON_RISPOSTO':
      return { label: 'Non risposto', tone: 'zinc', hint: 'Chiuso senza mai una risposta.' };
    case 'SILENTE':
      return { label: 'Silente', tone: 'zinc', hint: 'Fermo da un po’, ancora senza esito.' };
    default:
      return { label: reason, tone: 'zinc', hint: '' };
  }
}

export function StatusPill({
  label,
  tone,
  dot = true,
  className,
}: {
  label: string;
  tone: Tone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        TONE_PILL[tone],
        className,
      )}
    >
      {dot && <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />}
      {label}
    </span>
  );
}

/** Convenience wrappers so callers don't repeat the meta plumbing. */
export function ChatStatusPill({ status }: { status: string | null }) {
  const m = chatStatusMeta(status);
  return <StatusPill label={m.label} tone={m.tone} />;
}

export function SegmentPill({ segment }: { segment: string }) {
  const m = segmentMeta(segment);
  return <StatusPill label={m.label} tone={m.tone} />;
}

export function ReasonPill({ reason }: { reason: string | null }) {
  const m = reasonMeta(reason);
  if (!m) return null;
  return <StatusPill label={m.label} tone={m.tone} />;
}

/** Full taxonomy, used to render the explanatory legend. */
export const SEGMENT_LEGEND = ['PRESO', 'ATTIVA', 'FERMA', 'MAI_RISPOSTO'].map((s) => ({
  key: s,
  ...segmentMeta(s),
}));

export const REASON_LEGEND = ['RICHIAMO', 'INTERROTTO', 'NON_RISPOSTO', 'DA_SCARTARE', 'SILENTE']
  .map((r) => ({ key: r, ...reasonMeta(r)! }));
