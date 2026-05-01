import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function StatCard({ title, value, sub, href, accent }: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  href?: string;
  accent?: 'green' | 'red' | 'default';
}) {
  const inner = (
    <Card className={cn(
      'transition hover:shadow-md',
      accent === 'green' && 'border-emerald-500/40',
      accent === 'red' && 'border-red-500/40',
    )}>
      <CardHeader className="pb-2"><CardTitle className="text-sm text-zinc-500">{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">{value}</div>
        {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
