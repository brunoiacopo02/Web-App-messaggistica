import type { getSupabaseAdmin } from './supabase/admin';
import type { LancioSettings } from './lancio-settings';
import type { TurnoLancioInput } from './lancio-turno';
import { generateLancioReply } from './lancio-reply';
import { classificaLancio, congedoEsplicito } from './lancio-classifica';
import {
  congedoInPiedi, inboundDelLotto, paroleDelCongedo, registrazionePromessa,
  TESTO_REGISTRAZIONE_PROMESSA_STASERA, ultimoTestoDelLotto,
} from './lancio-fase';
import { marcaRegistrazionePromessa } from './lancio-db';
import { puoRispondere } from './lancio-scelta';
import { zoomMeetingId } from './lancio-zoom-blast';
import {
  congedoLancio, contestoDi, eventoAtDa, eventoLancio, historyDi, inviaBollaLancio,
  silenzioLancio, tracciaTurnoLancio, type StatoTurno,
} from './lancio-effetti';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const NOTA_CONGEDO = 'Lancio Web Dev AI: ha ricevuto il link Zoom e ha detto di non essere interessato.';
/**
 * Al posto della riga del modello quando scrive [PASSAGGIO_UMANO]: il lancio non passa MAI
 * la chat a una persona (PO 25/09/2026), e "ti aiuta subito un collega" prometterebbe un
 * aiuto che non arriva. Il bot resta lui ad aiutare: una mossa concreta e la domanda che
 * gli serve per proporre la prossima.
 */
export const TESTO_ASSISTENZA_SENZA_PASSAGGIO =
  'Ti aiuto io: apri il link di questa chat dal browser e scegli "partecipa dal browser", non serve nessuna app. Se non va, dimmi cosa vedi sullo schermo.';

/**
 * Fase `link_inviato` (spec §5.3): dal blast del link (90' prima dell'evento) alle 23:59
 * di Roma del giorno dell'evento il bot fa solo assistenza al collegamento — una bolla
 * breve del modello, col prompt di assistenza (ID riunione = i numeri del link, niente
 * passcode, app/browser/riclicca). Zero pitch: la live è fatta per quello.
 *
 * Dopo mezzanotte la fase resta `link_inviato` (il cron del follow-up del B5 la cerca
 * così) ma qui non si risponde più: silenzio definitivo, tracciato, perché il 6 arriva il
 * follow-up e da lì risponde Mario. Un rifiuto ESPLICITO è un congedo anche qui, così il
 * follow-up non raggiunge chi si è appena tirato fuori.
 *
 * Si classifica sul LOTTO (`inboundDelLotto`), non sull'inbound che il drain ha scelto:
 * è la stessa lezione del turno del B1 — con uno sticker o un "ok" davanti, un "toglimi
 * dalla lista" finiva nell'ombra e al CRM non arrivava niente.
 */
export async function turnoAssistenza(
  supabase: Supa,
  i: TurnoLancioInput,
  ctx: { settings: LancioSettings; now: Date },
): Promise<StatoTurno> {
  const genera = i.genera ?? generateLancioReply;
  const c = contestoDi(i);

  // Il congedo è già uscito e la fase non è terminale: il CRM aveva rifiutato l'esito e
  // questo turno serve solo a ritentarlo. Prima della finestra, perché non manda niente
  // al lead: un ritentativo alle 09:00 del 6 costa una chiamata al CRM e toglie dal
  // limbo un lead che aveva già detto no. Niente modello, niente seconda bolla, nessuna
  // riclassificazione — chi ha detto no resta un no anche se poi scrive "ok".
  // Un congedo sciolto (Task 3) non si ritenta: la frase e' in cronologia, il no no.
  if (congedoInPiedi(i.rows, i.lancioInfo)) {
    return congedoLancio(supabase, c, paroleDelCongedo(i.rows) ?? '', NOTA_CONGEDO, { giaInviato: true });
  }

  if (!puoRispondere(ctx.now, eventoAtDa(ctx.settings), 'link_inviato')) {
    // Il giorno dopo chiede la registrazione (PO 06/10/2026): fino a qui restava muto
    // fino al suo turno di follow-up, in una coda di migliaia a 1.000 al giorno. Si marca
    // la promessa e basta: la manda il cron del follow-up, che le registrazioni le serve
    // per prime e fuori dal tetto. Niente bolla qui, il template arriva entro 5 minuti
    // (dentro la fascia del follow-up).
    if (!registrazionePromessa(i.lancioInfo) && inboundDelLotto(i.rows).some((m) => classificaLancio(m.body) === 'registrazione')) {
      await marcaRegistrazionePromessa(supabase, c.conversationId);
      await eventoLancio(supabase, c, 'lancio_registrazione_chiesta_dopo_live', { testo: ultimoTestoDelLotto(inboundDelLotto(i.rows)).slice(0, 300) },
        `[lancio] conv ${c.conversationId}: ha chiesto la registrazione dopo la live, la manda il cron del follow-up`);
    }
    return silenzioLancio(supabase, c, 'assistenza_finita', true);
  }

  // L'ultima posizione leggibile del lead: chi ha scritto "ok" e poi "toglimi" ha detto no.
  const testoLead = ultimoTestoDelLotto(inboundDelLotto(i.rows));
  // Solo media (una foto, un audio, uno sticker): non c'è niente da leggere e il modello
  // si pagherebbe per niente. La traccia c'è lo stesso, o il re-drive ci torna ogni ora.
  if (testoLead === '') return silenzioLancio(supabase, c, 'inbound_senza_testo', true);

  // Qui le regex si fermano al rifiuto ESPLICITO: in assistenza il bot fa domande ("hai
  // l'app Zoom?", "il link ti si apre?") e il "no" secco è la risposta a quelle, non un
  // congedo. Chiudere lì scartava al CRM un lead che stava chiedendo aiuto per entrare
  // nella live. Tutto il resto — "no" compreso — va al modello, che il congedo può
  // dichiararlo lo stesso con la classe o col tag (sotto).
  if (congedoEsplicito(testoLead)) {
    return congedoLancio(supabase, c, testoLead, NOTA_CONGEDO);
  }

  const zoomLink = ctx.settings.zoomLink;
  const giaPromessa = registrazionePromessa(i.lancioInfo);
  const r = await genera(historyDi(i.rows), {
    fase: 'link_inviato',
    nome: i.nome,
    eventoAt: ctx.settings.eventoAt,
    now: ctx.now,
    zoomLink,
    // L'ID riunione si legge dal link, non si inventa: senza link nelle impostazioni il
    // prompt lo sa e dice al lead di usare quello che ha ricevuto.
    meetingId: zoomLink ? zoomMeetingId(zoomLink) : null,
    registrazionePromessa: giaPromessa,
  });

  if (r.passToHuman) {
    await eventoLancio(supabase, c, 'lancio_passaggio_umano_ignorato', { testo: testoLead.slice(0, 300), risposta: r.visibleReply.slice(0, 300) },
      `[lancio] conv ${c.conversationId}: il modello voleva passare la chat a una persona, ignorato`);
  }
  // Il no che le regex non hanno visto: il modello lo dice con la classe o col tag.
  if (r.classe === 'no' || r.lancioTag?.tag === 'NO') {
    return congedoLancio(supabase, c, testoLead, NOTA_CONGEDO);
  }

  // Non puo' esserci stasera o chiede la registrazione (PO 01/10/2026): mai un congedo,
  // gli si promette la registrazione per domani. Prima il prompt diceva "non prometti
  // nessuna registrazione, di' che le scriviamo noi domani": una promessa vaga che non
  // manteneva nessuno. Qui la decide il modello col tag e non una regex: la sera della
  // live "non riesco a collegarmi" e' quasi sempre un problema tecnico, non un no.
  // Se l'ha gia' avuta, la frase fissa non riparte: vale la risposta del modello.
  if (r.classe === 'registrazione' && !giaPromessa) {
    await inviaBollaLancio(supabase, c, TESTO_REGISTRAZIONE_PROMESSA_STASERA);
    await marcaRegistrazionePromessa(supabase, c.conversationId);
    await eventoLancio(supabase, c, 'lancio_registrazione_promessa', { testo: testoLead.slice(0, 300) },
      `[lancio] conv ${c.conversationId}: non puo' esserci stasera, promessa la registrazione`);
    await tracciaTurnoLancio(supabase, c, 'registrazione');
    return 'active';
  }

  const testo = r.passToHuman ? TESTO_ASSISTENZA_SENZA_PASSAGGIO : r.visibleReply.trim();
  if (!testo) return silenzioLancio(supabase, c, 'risposta_vuota', true);
  await inviaBollaLancio(supabase, c, testo);
  await eventoLancio(supabase, c, 'lancio_assistenza', { classe: r.classe }, `[lancio] conv ${c.conversationId}: assistenza al collegamento`);
  await tracciaTurnoLancio(supabase, c, 'assistenza');
  return 'active';
}
