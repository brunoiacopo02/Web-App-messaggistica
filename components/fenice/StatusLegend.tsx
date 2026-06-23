import { StatusPill, SEGMENT_LEGEND, REASON_LEGEND } from './status';

/**
 * Inline glossary so an operator never has to guess what a label means.
 * Rendered collapsed inside a <details> to stay out of the way until needed.
 */
export function StatusLegend() {
  return (
    <details className="group rounded-2xl border border-border/70 bg-card/60">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium select-none">
        <span>Cosa significano gli stati?</span>
        <span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="space-y-5 border-t border-border/70 px-4 py-4">
        <LegendBlock
          title="Segmenti"
          caption="In che fase del funnel si trova il lead."
          items={SEGMENT_LEGEND}
        />
        <LegendBlock
          title="Motivi / esiti"
          caption="Perché una conversazione è ferma o come si è chiusa."
          items={REASON_LEGEND}
        />
      </div>
    </details>
  );
}

function LegendBlock({
  title,
  caption,
  items,
}: {
  title: string;
  caption: string;
  items: { key: string; label: string; tone: Parameters<typeof StatusPill>[0]['tone']; hint: string }[];
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-brand">{title}</div>
      <p className="mb-3 text-xs text-muted-foreground">{caption}</p>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.key} className="flex items-start gap-3">
            <StatusPill label={it.label} tone={it.tone} className="mt-0.5 shrink-0" />
            <span className="text-sm text-muted-foreground">{it.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
