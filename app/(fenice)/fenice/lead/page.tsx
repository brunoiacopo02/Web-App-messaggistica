import { LeadPipeline } from './_components/LeadPipeline';

export const dynamic = 'force-dynamic';

export default function FeniceLeadPage() {
  return (
    <div className="h-full overflow-auto">
      <LeadPipeline />
    </div>
  );
}
