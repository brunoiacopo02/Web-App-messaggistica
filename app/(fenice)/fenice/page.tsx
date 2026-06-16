import { Simulator } from './_components/Simulator';

export default function FenicePage() {
  return (
    <div className="h-full flex flex-col">
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Simulatore — Mario</h1>
        <p className="text-sm text-zinc-500">Scrivi come se fossi il lead. Mario risponde. Niente WhatsApp reale.</p>
      </header>
      <Simulator />
    </div>
  );
}
