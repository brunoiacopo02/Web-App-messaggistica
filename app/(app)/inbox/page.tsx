import { Inbox } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default function InboxPage() {
  return (
    <div className="hidden md:flex flex-1 items-center justify-center text-zinc-400">
      <div className="text-center">
        <Inbox className="size-10 mx-auto mb-2" />
        <p>Seleziona una conversazione</p>
      </div>
    </div>
  );
}
