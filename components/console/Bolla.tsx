'use client';

import { memo } from 'react';
// Check/CheckCheck li chiede il brief del Task 7: sono le spunte di consegna di WhatsApp, non decorazione.
// avoid-ai-design-ignore: I3
import { AlertCircle, Check, CheckCheck, Clock } from 'lucide-react';
import { eFallito, erroreTwilio, statoConsegnaLeggibile } from '@/lib/lancio-monitor';
import { oraRoma, type Msg } from '@/lib/console/thread';
import { Tooltip } from './ui/Tooltip';

/** Icone di stato: `size={16}` come tutte, ridotte a 12 px dal CSS (`.consegna .ico`, brief Task 7). */
const ICONA = { size: 16, strokeWidth: 1.75, className: 'ico', 'aria-hidden': true } as const;

/** Stato di consegna di un messaggio in uscita: icona più parola, mai il solo colore. */
function Consegna({ m }: { m: Msg }) {
  const stato = m.twilio_status;
  if (eFallito(stato)) {
    const codice = m.twilio_error_code;
    const errore = codice != null ? erroreTwilio(codice) : null;
    const testo = (
      <span className="consegna ko" tabIndex={errore ? 0 : undefined}>
        <AlertCircle {...ICONA} />
        {statoConsegnaLeggibile(stato)}
        {codice != null && <span className="mono">{codice}</span>}
      </span>
    );
    return errore ? <Tooltip contenuto={errore.nome}>{testo}</Tooltip> : testo;
  }
  const Icona = stato === 'read' || stato === 'delivered' ? CheckCheck : stato === 'sent' ? Check : Clock;
  return (
    <span className={stato === 'read' ? 'consegna letto' : 'consegna'}>
      <Icona {...ICONA} />
      {statoConsegnaLeggibile(stato)}
    </span>
  );
}

interface BollaProps {
  m: Msg;
  /** Primo messaggio del blocco: per il lead apre il blocco con 12 px di stacco (mockup). */
  primo: boolean;
}

/** Una bolla con la sua riga di orario (e stato di consegna, se in uscita). */
export const Bolla = memo(function Bolla({ m, primo }: BollaProps) {
  const lead = m.direction === 'in';
  return (
    <>
      <div className={lead ? 'b lead' : 'b mario'} style={lead && primo ? { marginTop: 12 } : undefined}>
        {m.body}
      </div>
      <div className={lead ? 'meta' : 'meta r'}>
        <time dateTime={m.created_at}>{oraRoma(m.created_at)}</time>
        {m.is_template && <span>template</span>}
        {!lead && <Consegna m={m} />}
      </div>
    </>
  );
});
