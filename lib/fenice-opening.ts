import { firstNameOf } from './name';

// Testo di apertura di Mario = corpo del template WhatsApp "aperturabotchat"
// (FENICE_OPENING_TEMPLATE_SID). È già la presentazione + prima domanda, quindi
// sostituisce il primo messaggio dello script: il simulatore parte da qui e nel
// live il template stesso fa da apertura (Mario poi prosegue senza ripresentarsi).
export function feniceOpening(name?: string | null): string {
  const n = firstNameOf(name);
  const greet = n ? `Buongiorno ${n},` : 'Buongiorno,';
  return `${greet} sono Mario tutor di Fenice Academy.\n\nTi scrivo perché ho visto che ci hai lasciato ora i tuoi contatti in una nostra pubblicità. Cosa ti ha incuriosito?`;
}
