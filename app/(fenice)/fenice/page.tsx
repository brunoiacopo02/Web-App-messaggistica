import { Bot } from 'lucide-react';
import { PageHeader } from '@/components/fenice/PageHeader';
import { Simulator } from './_components/Simulator';

export default function FenicePage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Bot}
        kicker="Banco di prova"
        title="Simulatore"
        description="Scrivi come se fossi il lead — Mario risponde in tempo reale. È una palestra: niente WhatsApp, nessun messaggio parte davvero."
      />
      <Simulator />
    </div>
  );
}
