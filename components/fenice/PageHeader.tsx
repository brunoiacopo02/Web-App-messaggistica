import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The header that opens every Fenice section. Always answers "what is this and
 * what do I do here" so no screen feels like an undocumented control panel.
 */
export function PageHeader({
  icon: Icon,
  kicker,
  title,
  description,
  actions,
  className,
}: {
  icon: LucideIcon;
  kicker: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'fenice-rise flex flex-wrap items-start justify-between gap-4 border-b border-border/70 px-6 py-5 md:px-8',
        className,
      )}
    >
      <div className="flex items-start gap-4">
        <span className="mt-0.5 grid size-11 shrink-0 place-items-center rounded-2xl border border-brand/25 bg-brand/10 text-brand">
          <Icon className="size-5" />
        </span>
        <div className="space-y-1">
          <div className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-brand">
            {kicker}
          </div>
          <h1 className="font-display text-2xl font-bold leading-tight tracking-tight">{title}</h1>
          <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
