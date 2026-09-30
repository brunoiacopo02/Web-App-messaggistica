/** Contenitore per i Portal di Radix (Dialog, Sheet, Tooltip). Le variabili dei token
 *  (`--s0`, `--line`, `--shadow`, …) sono dichiarate su `[data-console]`: un Portal senza `container`
 *  esplicito finirebbe su `document.body`, fuori da quello scope, e uscirebbe senza stile.
 *  Lettura sincrona durante il render (stato derivato, niente `useEffect`+`setState`): su `document`
 *  assente (SSR) torna `undefined` e il Portal di Radix non monta nulla finché non siamo nel browser. */
export function contenitoreConsole(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.querySelector<HTMLElement>('[data-console]') ?? undefined;
}
