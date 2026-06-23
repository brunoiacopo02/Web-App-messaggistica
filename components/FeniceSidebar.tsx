'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Flame, Bot, Radio, MessagesSquare, Users, LogOut } from 'lucide-react';
import { signOutAction } from '@/app/(auth)/login/actions';
import { ThemeToggle } from '@/components/ThemeToggle';

const NAV = [
  { href: '/fenice', label: 'Simulatore', desc: 'Prova Mario senza WhatsApp', icon: Bot, exact: true },
  { href: '/fenice/live', label: 'Live', desc: 'Auto-risposta e nuovi lead', icon: Radio },
  { href: '/fenice/conversazioni', label: 'Conversazioni', desc: 'Storico chat e riassunti', icon: MessagesSquare },
  { href: '/fenice/lead', label: 'Lead', desc: 'Pipeline, report e analisi', icon: Users },
];

function useActive() {
  const pathname = usePathname();
  return (item: (typeof NAV)[number]) =>
    item.exact ? pathname === item.href : pathname?.startsWith(item.href);
}

function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span className="grid size-9 place-items-center rounded-xl bg-brand text-brand-foreground shadow-sm shadow-brand/30">
        <Flame className="size-5" />
      </span>
      <div className="leading-tight">
        <div className="font-display text-lg font-bold tracking-tight">Fenice</div>
        <div className="text-[0.7rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Mario · assistente
        </div>
      </div>
    </div>
  );
}

export function FeniceSidebar({ userEmail }: { userEmail: string }) {
  const isActive = useActive();

  return (
    <>
      {/* ── Desktop rail ─────────────────────────────────────────── */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border/70 bg-card/40 md:flex">
        <div className="px-5 py-5">
          <BrandMark />
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => {
            const active = isActive(item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors',
                  active
                    ? 'fenice-rail bg-brand/10 text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'mt-0.5 size-[18px] shrink-0 transition-colors',
                    active ? 'text-brand' : 'text-muted-foreground group-hover:text-foreground',
                  )}
                />
                <span className="min-w-0">
                  <span className={cn('block text-sm', active ? 'font-semibold' : 'font-medium')}>
                    {item.label}
                  </span>
                  <span className="block text-xs text-muted-foreground/80">{item.desc}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="space-y-3 border-t border-border/70 p-4">
          <div className="truncate text-xs text-muted-foreground" title={userEmail}>
            {userEmail}
          </div>
          <div className="flex items-center justify-between gap-2">
            <ThemeToggle />
            <form action={signOutAction}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
              >
                <LogOut className="size-3.5" /> Esci
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* ── Mobile top bar ───────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border/70 bg-card/80 px-4 py-3 backdrop-blur md:hidden">
        <div className="flex items-center justify-between">
          <BrandMark />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <form action={signOutAction}>
              <button
                type="submit"
                aria-label="Esci"
                className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
              >
                <LogOut className="size-4" />
              </button>
            </form>
          </div>
        </div>
        <nav className="-mx-1 flex gap-1 overflow-x-auto pb-0.5">
          {NAV.map((item) => {
            const active = isActive(item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'border-brand/30 bg-brand/10 font-semibold text-brand'
                    : 'border-transparent text-muted-foreground hover:bg-muted',
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
