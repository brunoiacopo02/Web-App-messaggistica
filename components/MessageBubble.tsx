import { cn, formatRelativeShort } from '@/lib/utils';
import { DeliveryStatus } from './DeliveryStatus';

export function MessageBubble({ msg, campaignName }: {
  msg: { id: number; direction: 'in' | 'out'; body: string; created_at: string;
    twilio_status?: string | null; twilio_error_code?: number | null; is_template?: boolean | null };
  campaignName?: string | null;
}) {
  const out = msg.direction === 'out';
  return (
    <div className={cn('flex w-full', out ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[75%] rounded-2xl px-3 py-2 shadow-sm',
        out ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-zinc-100 dark:bg-zinc-800',
      )}>
        {msg.is_template && campaignName && (
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Template · {campaignName}</div>
        )}
        <div className="whitespace-pre-wrap break-words text-sm">{msg.body}</div>
        <div className="flex items-center gap-1 mt-1 justify-end text-[11px] text-zinc-500">
          <span>{formatRelativeShort(msg.created_at)}</span>
          {out && <DeliveryStatus status={msg.twilio_status} errorCode={msg.twilio_error_code} />}
        </div>
      </div>
    </div>
  );
}
