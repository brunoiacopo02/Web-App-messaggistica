import { Check, CheckCheck, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function DeliveryStatus({ status, errorCode }: {
  status: string | null | undefined;
  errorCode: number | null | undefined;
}) {
  const Icon = (() => {
    switch (status) {
      case 'delivered': return CheckCheck;
      case 'read':      return CheckCheck;
      case 'sent':      return Check;
      case 'failed':
      case 'undelivered': return AlertTriangle;
      default: return Clock;
    }
  })();
  const color = status === 'read' ? 'text-blue-500'
    : status === 'failed' || status === 'undelivered' ? 'text-red-500'
    : 'text-zinc-400';
  const label = status ?? 'queued';
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px]" title={`${label}${errorCode ? ` (${errorCode})` : ''}`}>
      <Icon className={cn('size-3', color)} />
    </span>
  );
}
