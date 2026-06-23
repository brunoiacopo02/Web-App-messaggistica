import { Users } from 'lucide-react';
import { PageHeader } from '@/components/fenice/PageHeader';
import { LeadPipeline } from './_components/LeadPipeline';

export const dynamic = 'force-dynamic';

export default function FeniceLeadPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Users}
        kicker="Pipeline"
        title="Lead"
        description="Tutti i lead divisi per fase del funnel, con report di conversione e analisi AI delle obiezioni."
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <LeadPipeline />
      </div>
    </div>
  );
}
