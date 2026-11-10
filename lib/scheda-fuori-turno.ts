import { isMarkerProfessioni, isSlugProfessione, nomeProfessione, riconosciProfessione, type SlugProfessione } from './professioni';
import { chiedeLaScheda } from './professioni-nota';

/**
 * La scheda su una chat dove Mario NON risponde (PO 10/11/2026, caso Naomi conv 29726):
 * chat `handed_off`, `booked` o col fermo manuale (`ai_paused_at`). Se il lead manda la
 * frase del link o chiede la scheda (RICHIESTA_SCHEDA, la stessa regex di sempre) la
 * scheda parte lo stesso: la finestra delle 24 ore e' aperta perche' ha appena scritto.
 * Mario resta zitto; chi ha il lead riceve una nota.
 *
 * Il corso: quello segnato sulla chat, altrimenti quello nominato nel messaggio. Senza
 * corso niente invio: solo la nota, perche' chi ha il lead gli chieda quale.
 */
export type SchedaFuoriTurno = { slug: SlugProfessione | null };

export function schedaFuoriTurno(i: {
  aiOwner: string | null;
  aiStatus: string | null;
  aiPausedAt: string | null;
  professione: string | null;
  testo: string | null | undefined;
}): SchedaFuoriTurno | null {
  if (i.aiOwner !== 'mario') return null;
  const mutaPerStato = !!i.aiPausedAt || i.aiStatus === 'handed_off' || i.aiStatus === 'booked';
  if (!mutaPerStato) return null;
  const testo = i.testo ?? '';
  if (!isMarkerProfessioni(testo) && !chiedeLaScheda([testo])) return null;
  const slug = isSlugProfessione(i.professione) ? i.professione : riconosciProfessione(testo);
  return { slug };
}

/** La nota per chi ha il lead sul CRM: cosa ha chiesto e cosa e' partito. */
export function notaSchedaFuoriTurno(
  esito: 'inviata' | 'gia_inviata' | 'fallita' | 'senza_corso',
  slug: SlugProfessione | null,
  testo: string,
): string {
  const citazione = `Il lead ha scritto su WhatsApp: «${testo.trim().slice(0, 300)}».`;
  const corso = slug ? ` di ${nomeProfessione(slug)}` : '';
  switch (esito) {
    case 'inviata':
      return `${citazione} Ha chiesto la scheda del corso: gli abbiamo mandato in automatico il PDF${corso}. Il bot non gli ha risposto: la chat la segui tu.`;
    case 'gia_inviata':
      return `${citazione} Ha chiesto la scheda del corso${corso}: gliel'avevamo gia' mandata, e' sopra in chat. Il bot non gli ha risposto: la chat la segui tu.`;
    case 'fallita':
      return `${citazione} Ha chiesto la scheda del corso${corso} ma l'invio automatico del PDF non e' riuscito. Il bot non gli ha risposto: ricontattalo tu.`;
    case 'senza_corso':
      return `${citazione} Ha chiesto la scheda di un corso ma non sappiamo quale: chiediglielo tu. Il bot non gli ha risposto.`;
  }
}
