import type { getSupabaseAdmin } from './supabase/admin';
import type { Json } from './supabase/types';
import type { LancioSettings } from './lancio-settings';
import type { TurnoLancioInput } from './lancio-turno';
import { generateLancioReply } from './lancio-reply';
import { RISPOSTE_RISCALDAMENTO, type PercorsoLancio } from './lancio-prompt';
import { impostaFaseLancio } from './lancio-db';
import { sendCrmNota } from './bot-outcome';
import { pushLeadEntrante } from './lead-entrante';
import { PROVENIENZA_LANCIO_WEBDEV, isMarkerPulsanteWebinar } from './primo-messaggio';
import {
  haCongedo, paroleDelCongedo, inboundDelLotto, ultimoTestoDelLotto, conMarioDopoNotte, type RigaLancio,
} from './lancio-fase';
import { lancioProssimi, lancioBook, lancioCallNow, type LancioInfo, type LancioKind } from './lancio-crm';
import { romeDayKey, romeHour } from './rome-time';
import {
  giorniLancio, modoPostPitch, puoRispondere, validaAtLancio, oreDaProssimi, testoOreTreStrade, bloccoOrePerPrompt,
  testoConfermaChiamata, testoConfermaPrenotazione, testoOraEsaurita, testoAtNonValido, raccogliRisposte,
  etichettaGiorno, dopoLaNotteDelLancio, DOMANDE_PER_PERCORSO, giornoSuccessivo,
  type LancioTag, type OreTreStrade,
  TESTO_NESSUN_VENDITORE, TESTO_CHIAMATA_FUORI_ORARIO, TESTO_ERRORE_CRM, TESTO_DOPO_SCELTA, TESTO_CONGEDO_POST_PITCH,
  TESTO_INTRO_PREQUALIFICA, TESTO_INTRO_CONFERME,
} from './lancio-scelta';
import {
  congedoLancio, contestoDi, historyDi, eventoAtDa, inviaBollaLancio, inviaSceltaLancio, eventoLancio, tracciaTurnoLancio,
  silenzioLancio, type StatoTurno, type ContestoTurno,
} from './lancio-effetti';
import { eDomandaScelta, tapPulsanteScelta } from './lancio-pulsanti';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export const NOTA_SCELTA = 'Lancio Web Dev AI: ha premuto il pulsante dopo la live.';
/** La stessa provenienza dell'intake (B2): il bucket del lancio sul CRM è uno solo. */
export const PROVENIENZA_LANCIO = PROVENIENZA_LANCIO_WEBDEV;
const NOTA_CONGEDO = 'Lancio Web Dev AI: ha seguito la live ma non vuole una call.';
const NOTA_SENZA_ORE = 'Lancio Web Dev AI: vuole una call ma non ci sono ore libere nei prossimi 30 giorni.';
/** Quanto delle parole del lead entra nella nota al CRM dopo la scelta. */
const MAX_PAROLE_NOTA = 300;
/** `gia_prenotato` senza `appointmentAt`: il CRM dice che l'ora c'è ma non qual è. */
const TESTO_GIA_PRENOTATO_SENZA_ORA =
  'Risulta che hai già un appuntamento fissato con noi: ti richiamiamo noi, non serve fissarne un altro.';

/** I testi (non vuoti) del lotto, nell'ordine in cui il lead li ha scritti. */
const testiDelLotto = (lotto: RigaLancio[]): string[] =>
  lotto.map((m) => (m.body ?? '').trim()).filter((t) => t !== '');

/**
 * 409 `gia_prenotato` (contratto §6.2): il lead ha già la sua ora sul CRM — l'ha presa
 * dal sito, dai GDO, o da un turno di questo stesso bot andato a buon fine di cui non
 * ha visto la conferma. Non è un errore da far vedere al lead: gli si ricorda l'ora che
 * ha, e basta. L'ora si formatta con gli stessi ferri dei testi fissi (`etichettaGiorno`
 * + l'ora di Roma), così "martedì 6 ottobre alle 11:00" è scritto una volta sola in
 * tutto il blocco.
 */
function testoGiaPrenotato(appointmentAt: string | null): string {
  if (!appointmentAt) return TESTO_GIA_PRENOTATO_SENZA_ORA;
  const ms = Date.parse(appointmentAt);
  if (!Number.isFinite(ms)) return TESTO_GIA_PRENOTATO_SENZA_ORA;
  const d = new Date(ms);
  return `Risulta che hai già un appuntamento con noi ${etichettaGiorno(romeDayKey(d))} alle ${romeHour(d)}:00: ti chiamiamo lì, non serve fissarne un altro.`;
}

/**
 * Fase `post_pitch` (spec §5.4, tre strade PO 02/10): il lead ha premuto il pulsante dopo
 * la live. Prima la scelta fra "adesso" e "una call", poi le domande della strada scelta
 * (le risposte finiscono in `lancio_info` e poi al venditore): due per la chiamata subito,
 * tre di prequalifica per la mattina col venditore e per le Conferme. Il modello NON scrive mai un'ora: le ore le elenca il
 * codice nel prompt (blocco ORE PRENOTABILI, dal CRM), il modello le riporta in un tag e
 * il tag torna qui per le regole dure — date ammesse, ora tonda, `at ≥ now+1h`, chiamata
 * immediata solo di notte. Ogni conferma è un testo fisso.
 *
 * Un solo tag per turno e una sola chiamata al CRM per tag: il turno gira dentro il
 * drain, il lead sta aspettando la bolla.
 */
export async function turnoPostPitch(
  supabase: Supa,
  i: TurnoLancioInput,
  ctx: { settings: LancioSettings; now: Date },
): Promise<StatoTurno | 'handed_to_mario'> {
  const genera = i.genera ?? generateLancioReply;
  const c = contestoDi(i);
  const now = ctx.now;
  const eventoAt = eventoAtDa(ctx.settings);
  const giorni = giorniLancio(eventoAt);
  // `modo` dice se la chiamata immediata e' ancora possibile (la notte del webinar). Come
  // si chiamano i giorni ("domattina", "oggi pomeriggio", "mercoledì 7 ottobre") lo
  // decide `testoOreTreStrade` dal giorno di Roma di `now`.
  const modo = modoPostPitch(now, eventoAt);

  // Il congedo è già uscito e la fase non è terminale: il CRM aveva rifiutato lo scarto
  // e questo turno serve solo a ritentarlo. Niente modello, niente seconda bolla, nessuna
  // riclassificazione — chi ha detto no resta un no anche se poi scrive "ok". Si legge
  // dal marcatore durevole (`lancio_info.congedo_at`, scritto da `marcaCongedo`) e non
  // dalla cronologia: `congedoGiaInviato` cerca la frase del B1, e qui il congedo ha il
  // suo testo. Prima della finestra, come nell'assistenza: un ritentativo non manda
  // niente al lead e toglie dal limbo chi aveva già detto no.
  if (haCongedo(i.lancioInfo)) {
    return congedoLancio(supabase, c, paroleDelCongedo(i.rows) ?? '', NOTA_CONGEDO, { giaInviato: true });
  }

  // Finita la notte del webinar (dalle 03:00 del giorno dopo, decisione PO 25/09) i
  // pulsanti di scelta non esistono piu': chi scrive adesso da una chat rimasta a meta' del
  // dopo-pitch passa a Mario standard, che fissa l'appuntamento come per qualunque lead.
  // Come il ramo del follow-up (`eseguiTurnoLancio`): fase `chiuso` e 'handed_to_mario',
  // e a questo inbound risponde Mario NELLO STESSO drain, senza bolla qui. Il marcatore su
  // `lancio_info` tiene le risposte del riscaldamento e dice al drain quale nota usare:
  // Mario sa che la live l'ha vista e non gli rifa' le domande della sera.
  // Sta DOPO il congedo (chi ha detto no resta un no) e PRIMA della finestra oraria: la
  // regola 08:30-23:00 era del dopo-pitch, e Mario risponde come a chiunque.
  // Chi invece resta in silenzio non passa di qui: resta `post_pitch`, riceve il
  // follow-up del 6 e torna a Mario quando risponde.
  const aMario = async (): Promise<'handed_to_mario'> => {
    const lancioInfo = conMarioDopoNotte(i.lancioInfo ?? null, 'post_pitch', now.toISOString());
    await impostaFaseLancio(supabase, c.conversationId, 'chiuso', { lancio_info: lancioInfo as unknown as Json });
    await eventoLancio(supabase, c, 'lancio_post_pitch_a_mario', { risposte: (i.lancioInfo?.risposte ?? []).length },
      `[lancio] conv ${c.conversationId}: post-pitch dopo la notte del webinar, la chat passa a Mario standard`);
    return 'handed_to_mario';
  };
  // Eccezione (fix review finale, ruling 2): chi alle 03:00 era a meta' delle domande con
  // un'ora GIA' scelta (mattina o Conferme) e ancora valida non la perde: si prenota quella
  // ora con le risposte raccolte fin qui, poi conferma e `scelta_fatta`. Se il book non va
  // (ora esaurita, regole, CRM giu') si torna al passaggio a Mario di sempre.
  const dopoNotte = dopoLaNotteDelLancio(now, ctx.settings.eventoAt);
  const percorsoSalvato = i.lancioInfo?.percorso ?? null;
  const oraSalvata = i.lancioInfo?.oraScelta ?? null;
  const oraDaSalvare = dopoNotte && (percorsoSalvato === 'mattina' || percorsoSalvato === 'conferme')
    && oraSalvata && validaAtLancio(oraSalvata, now, eventoAt).ok
    ? oraSalvata
    : null;
  if (dopoNotte && !oraDaSalvare) return aMario();

  // Fuori orario (03:00-08:30, dopo le 23:00): silenzio TEMPORANEO, senza traccia, così
  // il re-drive di bot-followups delle 08:30 rifà il turno e risponde. Vale anche per
  // l'ora da salvare dopo la notte: la prenotazione parte dal re-drive delle 08:30.
  if (!puoRispondere(now, eventoAt, 'post_pitch')) return silenzioLancio(supabase, c, 'fuori_orario', false);

  // Si lavora sul LOTTO, non sull'inbound che il drain ha scelto (il primo rimasto senza
  // risposta): è la stessa lezione del turno del B1 e dell'assistenza. Con uno sticker o
  // un "ok" davanti, il messaggio vero — "no, toglimi dalla lista", "alle 9 non posso
  // più" — finiva nell'ombra, e la traccia `fenice_ai_reply` toglieva pure il re-drive.
  const lotto = inboundDelLotto(i.rows);
  const testi = testiDelLotto(lotto);
  /** L'ultima posizione leggibile del lead: chi ha scritto "ok" e poi "no" ha detto no. */
  const testoLead = ultimoTestoDelLotto(lotto);
  // Niente da leggere (solo media, o un lotto vuoto perche' il taglio non ha lasciato
  // nessun inbound): come nell'assistenza si tace, con la traccia perche' il re-drive non
  // ci torni ogni ora. Senza questa guardia il turno pagava il modello, spendeva una
  // bolla su una cronologia vuota e poteva spingere al CRM un lead senza primo messaggio.
  // Dopo la notte con un'ora da salvare si prenota anche su un lotto di soli media.
  if (testoLead === '' && !oraDaSalvare) return silenzioLancio(supabase, c, 'inbound_senza_testo', true);

  // Le parole del lead, accumulate (il marker del pulsante no): sono le "info" per chi
  // chiama. Tutto il lotto, non solo l'ultimo: se ha risposto in due messaggi, al
  // venditore devono arrivare entrambi.
  const info: LancioInfo = raccogliRisposte(i.lancioInfo ?? null, testi);
  const faseScelta = info.risposte.length >= RISPOSTE_RISCALDAMENTO || !!info.slotsMostratiAt;

  // Le tre strade (PO 02/10): la scelta viene prima, le domande dopo e per strada. Lo
  // stato vive in `lancio_info` — `percorso`, `oraScelta`, `domande` — ed e' solo del bot:
  // al CRM viaggiano le sole `risposte`. `domande` conta gli inbound arrivati DENTRO un
  // percorso: si somma il lotto solo se il percorso era gia' aperto all'inizio del turno
  // (il messaggio con cui il lead sceglie non e' una risposta a una domanda). Si conta
  // PRIMA del modello, cosi' il prompt sa a che domanda siamo ("già fatte: 2 su 3").
  const percorsoIniziale: PercorsoLancio | null = info.percorso ?? null;
  const domandeIniziali = info.domande ?? 0;
  const oraSceltaIniziale = info.oraScelta ?? null;
  if (percorsoIniziale) info.domande = domandeIniziali + testi.length;
  const domande = () => info.domande ?? 0;
  /** Le due strade di prenotazione (mattina e Conferme): hanno un'ora, e fra loro il conteggio delle domande passa. */
  const conOra = (p: PercorsoLancio | null): p is 'mattina' | 'conferme' => p === 'mattina' || p === 'conferme';

  // Il tocco di un pulsante non passa dal modello (delibera PO 17/09): il titolo del
  // pulsante arriva come testo, e i quattro titoli sono quattro stringhe esatte. Vale solo
  // nella fase della scelta, cioe' dove i pulsanti sono stati davvero mandati: durante il
  // riscaldamento un "domani mattina" e' una frase del lead, e la legge il modello.
  const tap = faseScelta ? tapPulsanteScelta(testoLead) : null;

  // Update diretto: la fase non cambia, e `impostaFaseLancio` è l'unico scrittore di
  // `lancio_fase`, non di `lancio_info`.
  const salvaInfo = async (dati: LancioInfo): Promise<void> => {
    await supabase.from('conversations').update({ lancio_info: dati as unknown as Json }).eq('id', c.conversationId);
  };

  // Le ore si leggono una volta per turno e solo quando servono: la mattina dei venditori
  // e il primo giorno utile delle Conferme, dal giorno dopo la live in avanti. `null` =
  // CRM non raggiungibile. Cambio di comportamento rispetto al B4: prima, col CRM giu',
  // si proponevano pomeriggio e dopodomani a scatola chiusa (le Conferme non avevano
  // tetto). Ora le Conferme hanno un tetto per ora e il primo giorno utile lo sa solo il
  // CRM: proporre ore a caso romperebbe il tetto, quindi senza CRM non si propone niente.
  let ore: OreTreStrade | null = null;
  let oreLette = false;
  const leggiOre = async (): Promise<OreTreStrade | null> => {
    if (oreLette) return ore;
    oreLette = true;
    const r = await lancioProssimi(giorni.giornoDopo);
    if (!r.ok) {
      await eventoLancio(supabase, c, 'lancio_slots_non_letti', { motivo: r.motivo }, `[lancio] conv ${c.conversationId}: ore non lette dal CRM (${r.motivo}), nessuna ora proposta`, 'warn');
      ore = null;
      return null;
    }
    const lette = oreDaProssimi(r.prossimi, now);
    // Fix review finale (ruling 1): il giorno Conferme DOPO il primo, una sola lettura in
    // piu'. Non va nel testo al lead (l'ordine di riempimento e' del PO), solo nel prompt:
    // chi non puo' il primo giorno lo dice, e il modello ha un'ora vera da mettere nel tag.
    // Una lettura fallita non toglie niente: resta il primo giorno, come prima.
    if (lette.conferme) {
      const primo = lette.conferme.date;
      const r2 = await lancioProssimi(giornoSuccessivo(primo));
      if (r2.ok) {
        const alt = oreDaProssimi({ mattina: null, conferme: r2.prossimi.conferme, saltati: [] }, now).conferme;
        // Chiavi 'YYYY-MM-DD': l'ordine alfabetico e' quello cronologico.
        if (alt && alt.date > primo) lette.confermeAlternativo = alt;
      } else {
        await eventoLancio(supabase, c, 'lancio_slots_alternativo_non_letti', { motivo: r2.motivo }, `[lancio] conv ${c.conversationId}: secondo giorno Conferme non letto (${r2.motivo})`, 'warn');
      }
    }
    ore = lette;
    return ore;
  };

  /**
   * Manda il testo con le ore (scritto dal codice, `testoOreTreStrade` e le sue varianti)
   * e segna che le ore sono state mostrate. `forzate` sono le ore del 409 `ora_esaurita`:
   * la fotografia piu' fresca che c'e', non si rilegge niente.
   */
  const mostraOre = async (
    componi: (o: OreTreStrade) => string = (o) => testoOreTreStrade(o, now),
    forzate?: OreTreStrade | null,
  ): Promise<'active'> => {
    const o = forzate ?? (await leggiOre());
    if (!o) {
      // Senza CRM non si conoscono le ore: si chiede di riscrivere (l'evento warn l'ha
      // gia' scritto `leggiOre`). Nessuna ora inventata.
      await inviaBollaLancio(supabase, c, TESTO_ERRORE_CRM);
      await salvaInfo(info);
      await tracciaTurnoLancio(supabase, c, 'errore_crm');
      return 'active';
    }
    await inviaBollaLancio(supabase, c, componi(o));
    info.slotsMostratiAt = now.toISOString();
    await salvaInfo(info);
    if (!o.mattina && !o.conferme) {
      // Nessuna ora proposta: `lancio_slots_mostrati` direbbe il falso, e chi conta le
      // ore mostrate la sera del lancio conterebbe un turno in cui non ce n'era nessuna.
      // Il testo promette "lascio nota": la nota parte davvero, altrimenti nessuno lo
      // richiama. `sendCrmNota` rilegge da sé `crm_lead_id`, quindi non si filtra qui:
      // un lead adottato dentro questo turno la nota la deve avere lo stesso.
      const nota = await sendCrmNota(supabase, c.conversationId, NOTA_SENZA_ORE);
      await eventoLancio(supabase, c, 'lancio_slots_vuoti', { notaInviata: nota.sent, errore: nota.error ?? null }, `[lancio] conv ${c.conversationId}: nessuna ora libera nei prossimi giorni, nota al CRM`, 'warn');
    } else {
      await eventoLancio(supabase, c, 'lancio_slots_mostrati', { mattina: o.mattina, conferme: o.conferme, confermeAlternativo: o.confermeAlternativo ?? null, saltati: o.saltati, modo }, `[lancio] conv ${c.conversationId}: ore proposte`);
    }
    await tracciaTurnoLancio(supabase, c, 'slots');
    return 'active';
  };

  const erroreCrm = async (tipo: string, dettagli: Record<string, unknown>): Promise<'active'> => {
    await inviaBollaLancio(supabase, c, TESTO_ERRORE_CRM);
    await salvaInfo(info);
    await eventoLancio(supabase, c, tipo, dettagli, `[lancio] conv ${c.conversationId}: scelta non registrata (${tipo})`, 'error');
    await tracciaTurnoLancio(supabase, c, 'errore_crm');
    return 'active';
  };

  /** Il leadId per il CRM: quello della chat, riletto ora, o chiesto al CRM se manca ancora. */
  const leadIdPerCrm = async (): Promise<string | null> => {
    const { data } = await supabase.from('conversations').select('crm_lead_id').eq('id', c.conversationId).maybeSingle();
    const attuale = (data as { crm_lead_id: string | null } | null)?.crm_lead_id ?? c.crmLeadId;
    if (attuale) return attuale;
    // Numero sconosciuto che ha premuto il pulsante: il push del webhook (B2) è
    // fire-and-forget e può non essere arrivato. Il CRM deduplica per numero: si rispinge.
    //
    // Il "primo messaggio" è il primo DI QUESTO LANCIO, non il primo della chat: su una
    // chat riusata la cronologia comincia con un giro di Mario di settimane prima, e
    // mandare quello al CRM come primo messaggio del lead scriverebbe sulla scheda una
    // frase che col webinar non c'entra niente. L'ancora è il testo del pulsante; se non
    // è in cronologia (marker cambiato, riga potata) si ripiega sul lotto di adesso.
    const iPulsante = i.rows.findIndex((m) => m.direction === 'in' && isMarkerPulsanteWebinar(m.body));
    const dalLancio = iPulsante >= 0 ? i.rows.slice(iPulsante) : lotto;
    const primo = dalLancio.find((m) => m.direction === 'in' && (m.body ?? '').trim() !== '');
    const res = await pushLeadEntrante(supabase, {
      conversationId: c.conversationId, telefono: c.phone, nome: i.nome, provenienza: PROVENIENZA_LANCIO,
      primoMessaggio: primo?.body ?? null, scrittoIl: primo?.created_at ?? now.toISOString(),
    });
    return res.ok && res.leadId ? res.leadId : null;
  };

  const sceltaFatta = async (tipo: 'chiama_ora' | 'prenota' | 'gia_prenotato', extra: Record<string, unknown>): Promise<'closed'> => {
    await impostaFaseLancio(supabase, c.conversationId, 'scelta_fatta', { lancio_info: info as unknown as Json });
    await eventoLancio(supabase, c, 'lancio_scelta', { tipo, ...extra }, `[lancio] conv ${c.conversationId}: scelta ${tipo}`);
    await tracciaTurnoLancio(supabase, c, `scelta_${tipo}`);
    return 'closed';
  };

  /**
   * Il CRM dice che il lead ha già un appuntamento (409 `gia_prenotato`, da `book` o da
   * `call-now`). Si chiude come una prenotazione riuscita — stessa fase, stesso evento,
   * stesso `closed` — perché per il lead il risultato è lo stesso: ha la sua ora. Quello
   * che NON si fa è riprovare: l'appuntamento c'è già e un secondo giro lo duplicherebbe.
   */
  const giaPrenotato = async (
    esito: { appointmentAt: string | null; kind: LancioKind | null },
    tag: string,
  ): Promise<'closed'> => {
    await inviaBollaLancio(supabase, c, testoGiaPrenotato(esito.appointmentAt));
    return sceltaFatta('gia_prenotato', { at: esito.appointmentAt, kind: esito.kind, tag });
  };

  /**
   * La prenotazione dell'ora scelta: `book` col CRM. Solo quando le domande sono fatte.
   * `seFallisce` (solo dopo la notte, ruling 2): ogni esito che non e' una prenotazione
   * (lead senza CRM, ora esaurita, regole, errore) non riapre la scelta delle ore ma
   * passa la chat a Mario come prima.
   */
  const prenota = async (
    at: string,
    daTag: string,
    seFallisce?: () => Promise<'handed_to_mario'>,
  ): Promise<StatoTurno | 'handed_to_mario'> => {
    const leadId = await leadIdPerCrm();
    if (!leadId) return seFallisce ? seFallisce() : erroreCrm('lancio_lead_senza_crm', { tag: daTag, at });
    const esito = await lancioBook({ leadId, at, info: { risposte: info.risposte }, note: NOTA_SCELTA });
    if (esito.ok) {
      await inviaBollaLancio(supabase, c, testoConfermaPrenotazione(esito.kind, at, esito.venditore?.nome ?? null));
      return sceltaFatta('prenota', { at, kind: esito.kind, venditore: esito.venditore ?? null, deduped: esito.deduped === true, domande: domande() });
    }
    if (esito.motivo === 'gia_prenotato') return giaPrenotato(esito, daTag);
    if (seFallisce) {
      await eventoLancio(supabase, c, 'lancio_prenota_dopo_notte_fallita', { at, ...esito }, `[lancio] conv ${c.conversationId}: ora ${at} non prenotata dopo la notte (${esito.motivo}), passa a Mario`, 'warn');
      return seFallisce();
    }
    if (esito.motivo === 'ora_esaurita') {
      // L'ora si e' riempita mentre il lead rispondeva. Percorso e ora si azzerano, le
      // domande NO: chi ha gia' risposto non le rifa', e alla prossima ora scelta si
      // prenota subito (spec §2.2 punto 4: dalla mattina piena si passa alle Conferme
      // senza rifare le domande). Le ore aggiornate sono nel 409; se il CRM non le ha
      // mandate si rileggono, non si ripropongono quelle di prima.
      info.percorso = null;
      info.oraScelta = null;
      const h = romeHour(new Date(Date.parse(at)));
      if (!esito.prossimi) oreLette = false;
      const fresche = esito.prossimi ? oreDaProssimi(esito.prossimi, now) : null;
      return mostraOre((o) => testoOraEsaurita(h, o, now), fresche);
    }
    if (esito.motivo === 'nessun_venditore') {
      info.percorso = null;
      info.oraScelta = null;
      return mostraOre((o) => `${TESTO_NESSUN_VENDITORE} ${testoOreTreStrade(o, now)}`);
    }
    if (esito.motivo === 'fuori_regole') {
      await eventoLancio(supabase, c, 'lancio_at_non_valido', { at, motivo: 'crm_fuori_regole' }, `[lancio] conv ${c.conversationId}: il CRM rifiuta ${at} (422)`, 'warn');
      // Come per l'ora esaurita: si torna alla scelta dell'ora, le domande restano.
      info.percorso = null;
      info.oraScelta = null;
      return mostraOre((o) => testoAtNonValido(o, now));
    }
    return erroreCrm('lancio_crm_errore', { tag: daTag, at, ...esito });
  };

  // Con un tocco la scelta e' gia' fatta: niente prompt, niente ore nel prompt, niente
  // chiamata al modello. E' anche il turno piu' veloce della serata, che e' esattamente
  // quando la coda dei post-pitch e' piu' lunga.
  const bloccoDalleOre = async (): Promise<string | null> => {
    const o = await leggiOre();
    return o ? bloccoOrePerPrompt(o, now) : null;
  };
  // Dopo la notte, con un'ora valida gia' scelta: si prenota, ma prima si legge cosa ha
  // scritto il lead (PO 02/10, fix review finale). Col testo il modello gira UNA volta col
  // prompt del percorso aperto e le ore: NO → congedo, niente book; PRENOTA su un'ora
  // valida → si prenota QUELLA; tutto il resto (CONFERMA, domanda, nessun tag, SLOTS,
  // passaggio a persona) → l'ora gia' scelta. Senza testo (solo media) niente modello.
  if (oraDaSalvare) {
    let at = oraDaSalvare;
    let esitoModello: string = 'senza_testo';
    if (testoLead !== '') {
      const rN = await genera(historyDi(i.rows), {
        fase: 'post_pitch', nome: i.nome, eventoAt: ctx.settings.eventoAt, now,
        modo, risposteRaccolte: info.risposte.length, bloccoSlot: await bloccoDalleOre(),
        percorso: percorsoIniziale, domandeFatte: domande(),
      });
      const t = rN.lancioTag;
      if (t?.tag === 'NO') {
        await eventoLancio(supabase, c, 'lancio_prenota_dopo_notte', { at: oraDaSalvare, percorso: percorsoSalvato, esitoModello: 'no' },
          `[lancio] conv ${c.conversationId}: dopo la notte il lead dice no, niente prenotazione`);
        // Come il NO del turno normale: le risposte prima del congedo (vedi sotto).
        await salvaInfo(info);
        return congedoLancio(supabase, c, testoLead, NOTA_CONGEDO, { testo: TESTO_CONGEDO_POST_PITCH });
      }
      if (t?.tag === 'PRENOTA') {
        const v = validaAtLancio(t.at, now, eventoAt);
        if (v.ok) {
          at = t.at;
          info.oraScelta = t.at;
          info.percorso = v.kind === 'mattina' ? 'mattina' : 'conferme';
          esitoModello = 'altra_ora';
        } else {
          esitoModello = `prenota_non_valida_${v.motivo}`;
        }
      } else {
        esitoModello = t?.tag ?? 'nessun_tag';
      }
    }
    await eventoLancio(supabase, c, 'lancio_prenota_dopo_notte', { at, oraScelta: oraDaSalvare, percorso: percorsoSalvato, domande: domande(), esitoModello },
      `[lancio] conv ${c.conversationId}: dopo la notte, prenota ${at} (${esitoModello})`);
    return prenota(at, 'DOPO_NOTTE', aMario);
  }

  // Sulla chiamata le ore non servono (ruling 5, latenza la sera del lancio): se poi il
  // lead chiede un'ora, `primaDomanda` e `mostraOre` le leggono allora.
  const bloccoSlot = faseScelta && !tap && percorsoIniziale !== 'chiamata' ? await bloccoDalleOre() : null;
  const opzioniModello = {
    fase: 'post_pitch', nome: i.nome, eventoAt: ctx.settings.eventoAt, now,
    modo, risposteRaccolte: info.risposte.length, bloccoSlot,
  };
  const r = tap
    ? null
    : await genera(historyDi(i.rows), { ...opzioniModello, percorso: percorsoIniziale, domandeFatte: domande() });

  // Il lancio non passa MAI la chat a una persona (PO 25/09/2026): dopo la live la
  // persona e' il consulente della call, quindi un [PASSAGGIO_UMANO] vale come la
  // richiesta delle ore (SLOTS). Dentro un percorso la persona e' gia' scelta: e' chi lo
  // chiama (CHIAMA_ORA) o il tutor della videocall (CONFERMA, come un'obiezione: si fissa
  // e le domande le fa lui). Un tag di scelta vero, se il modello l'ha messo, vince.
  if (r?.passToHuman) {
    await eventoLancio(supabase, c, 'lancio_passaggio_umano_ignorato', { testo: testoLead.slice(0, 300), risposta: r.visibleReply.slice(0, 300), percorso: percorsoIniziale },
      `[lancio] conv ${c.conversationId}: il modello voleva passare la chat a una persona, resta nel percorso del lancio`);
  }

  if (tap) {
    await eventoLancio(supabase, c, 'lancio_scelta_pulsante_tap', { titolo: testoLead, tag: tap, modo }, `[lancio] conv ${c.conversationId}: pulsante "${testoLead}" -> ${tap}`);
  }
  const tagPassaggio: LancioTag = percorsoIniziale === 'chiamata'
    ? { tag: 'CHIAMA_ORA' }
    : conOra(percorsoIniziale) ? { tag: 'CONFERMA' } : { tag: 'SLOTS' };
  // Il tocco vale come il tag che il modello avrebbe scritto: da qui in giu' il flusso e'
  // lo stesso di sempre, regole dure comprese (di giorno CHIAMA_ORA diventa il testo fisso
  // "a quest'ora fissiamo la call" piu' le ore, come oggi).
  let tag: LancioTag | null = tap
    ? (tap === 'CHIAMA_ORA' ? { tag: 'CHIAMA_ORA' } : { tag: 'SLOTS' })
    : (r!.lancioTag ?? (r!.passToHuman ? tagPassaggio : null));

  // Le domande del percorso sono finite e il modello non ha chiuso (ha scritto un'altra
  // domanda, o niente tag): chiude il codice. Vale per le due domande della chiamata e per
  // le tre della prenotazione, ed e' anche il tetto di sicurezza contro il modello che non
  // chiude mai (`domande ≥ N + 2` e' compreso: si chiude gia' a N). Un tag esplicito —
  // NO, un'altra ora, le ore, la chiamata — resta del lead e vince.
  if (percorsoIniziale && !tag && domande() >= DOMANDE_PER_PERCORSO[percorsoIniziale]) {
    tag = percorsoIniziale === 'chiamata' ? { tag: 'CHIAMA_ORA' } : { tag: 'CONFERMA' };
    await eventoLancio(supabase, c, 'lancio_percorso_chiuso_dal_codice', { percorso: percorsoIniziale, domande: domande() },
      `[lancio] conv ${c.conversationId}: ${percorsoIniziale}, ${domande()} risposte, chiude il codice`);
  }

  /**
   * Si e' appena entrati in un percorso (o cambiata l'ora dentro uno): la prima domanda
   * la scrive il modello, rigenerata col percorso NUOVO — la prima chiamata aveva il
   * prompt della scelta, e le sue parole erano per un tag che il codice sostituisce. Una
   * sola rigenerazione per turno; il tag della seconda risposta si ignora (il lead non ha
   * ancora risposto a niente). Sulla mattina e sulle Conferme, entrando, la domanda e'
   * preceduta dall'introduzione fissa della prequalifica.
   */
  const primaDomanda = async (p: PercorsoLancio, intro: boolean): Promise<StatoTurno> => {
    info.percorso = p;
    info.domande = domande();
    const r2 = await genera(historyDi(i.rows), {
      ...opzioniModello, bloccoSlot: p === 'chiamata' ? null : (bloccoSlot ?? (await bloccoDalleOre())),
      percorso: p, domandeFatte: domande(),
    });
    const domanda = (r2.visibleReply ?? '').trim();
    if (!domanda) {
      // Ruling 3: senza domanda l'introduzione da sola non parte. Il turno non cambia lo
      // stato del percorso (percorso, ora, conteggio restano quelli di inizio turno: la
      // domanda non e' stata fatta); le parole del lead restano nelle risposte.
      info.percorso = percorsoIniziale;
      info.oraScelta = oraSceltaIniziale;
      info.domande = domandeIniziali;
      await salvaInfo(info);
      return silenzioLancio(supabase, c, 'risposta_vuota', true);
    }
    // Ruling 4: sulle Conferme l'introduzione spinge meno.
    const testoIntro = p === 'conferme' ? TESTO_INTRO_CONFERME : TESTO_INTRO_PREQUALIFICA;
    const testo = intro ? `${testoIntro} ${domanda}` : domanda;
    await salvaInfo(info);
    await inviaBollaLancio(supabase, c, testo);
    await eventoLancio(supabase, c, 'lancio_percorso', { percorso: p, oraScelta: info.oraScelta ?? null, domande: domande(), da: percorsoIniziale },
      `[lancio] conv ${c.conversationId}: percorso ${p}${info.oraScelta ? ` (${info.oraScelta})` : ''}`);
    await tracciaTurnoLancio(supabase, c, 'post_pitch');
    return 'active';
  };

  /** La chiamata subito: call-now col CRM. Esiste solo la notte del webinar. */
  const chiamaOra = async (): Promise<StatoTurno> => {
    // Regola dura: la chiamata immediata esiste solo la notte del webinar.
    if (modo !== 'notte') {
      info.percorso = null;
      return mostraOre((o) => `${TESTO_CHIAMATA_FUORI_ORARIO} ${testoOreTreStrade(o, now)}`);
    }
    const leadId = await leadIdPerCrm();
    if (!leadId) return erroreCrm('lancio_lead_senza_crm', { tag: 'CHIAMA_ORA' });
    const esito = await lancioCallNow({ leadId, info: { risposte: info.risposte }, note: NOTA_SCELTA });
    if (esito.ok) {
      await inviaBollaLancio(supabase, c, testoConfermaChiamata(esito.venditore.nome));
      return sceltaFatta('chiama_ora', { venditore: esito.venditore, domande: domande() });
    }
    if (esito.motivo === 'gia_prenotato') return giaPrenotato(esito, 'CHIAMA_ORA');
    if (esito.motivo === 'nessun_venditore') {
      // Turno SERA vuoto: si ripiega sulla prenotazione. Le risposte restano (vanno al
      // CRM), ma il conteggio no: le due domande della chiamata non sono la prequalifica
      // della videocall, che si fa da capo (fix round 1). `domande` passa SOLO fra le due
      // strade di prenotazione, mattina e Conferme (spec §2.2 punto 4).
      info.percorso = null;
      info.domande = 0;
      return mostraOre((o) => `${TESTO_NESSUN_VENDITORE} ${testoOreTreStrade(o, now)}`);
    }
    // `conflitto` compreso: il client l'ha già ritentato una volta, qui si dice al lead
    // di riscrivere invece di martellare il CRM dentro il turno.
    return erroreCrm('lancio_crm_errore', { tag: 'CHIAMA_ORA', ...esito });
  };

  switch (tag?.tag) {
    case 'CHIAMA_ORA': {
      // Dentro la chiamata (seconda risposta, obiezione, tocco ripetuto) si chiama. Da
      // fuori si entra nel percorso e si fa la prima domanda. Le risposte della
      // prenotazione NON valgono per la chiamata (fix round 1): le domande sono altre, il
      // conteggio riparte da zero e l'ora scelta prima non vale piu'.
      if (modo !== 'notte' || percorsoIniziale === 'chiamata') return chiamaOra();
      info.oraScelta = null;
      info.domande = 0;
      return primaDomanda('chiamata', false);
    }
    case 'CONFERMA': {
      // Fine delle domande: si prenota l'ora scelta (o si chiama, nella chiamata). Senza
      // percorso il tag non ha senso: si tratta come una risposta qualunque, sotto.
      if (percorsoIniziale === 'chiamata') return chiamaOra();
      if (conOra(percorsoIniziale) && info.oraScelta) return prenota(info.oraScelta, 'CONFERMA');
      break;
    }
    case 'PRENOTA': {
      const v = validaAtLancio(tag.at, now, eventoAt);
      if (!v.ok) {
        await eventoLancio(supabase, c, 'lancio_at_non_valido', { at: tag.at, motivo: v.motivo }, `[lancio] conv ${c.conversationId}: ora ${tag.at} rifiutata (${v.motivo})`);
        return mostraOre((o) => testoAtNonValido(o, now));
      }
      // Dentro una prenotazione, cambiare ora non e' una risposta a una domanda: il
      // conteggio del lotto si toglie. Dalla chiamata alla prenotazione il conteggio
      // riparte da zero: le risposte della chiamata non sono la prequalifica.
      if (conOra(percorsoIniziale)) info.domande = domandeIniziali;
      if (percorsoIniziale === 'chiamata') info.domande = 0;
      const nuovo: 'mattina' | 'conferme' = v.kind === 'mattina' ? 'mattina' : 'conferme';
      info.oraScelta = tag.at;
      info.percorso = nuovo;
      // Chi ha gia' risposto (su questa o su un'altra strada) non rifa' le domande.
      if (domande() >= DOMANDE_PER_PERCORSO[nuovo]) return prenota(tag.at, 'PRENOTA');
      return primaDomanda(nuovo, !conOra(percorsoIniziale));
    }
    case 'SLOTS':
      // Chi era sulla chiamata e chiede le ore ha cambiato idea: si torna alla scelta.
      if (percorsoIniziale === 'chiamata') info.percorso = null;
      return mostraOre();
    case 'NO': {
      // Le risposte si salvano PRIMA del congedo: `congedoLancio` → `marcaCongedo` legge
      // `lancio_info` dal DB e ci aggiunge `congedo_at`, quindi trova le risposte già
      // scritte e non le perde. Scriverle dopo (o passarle a `impostaFaseLancio`)
      // cancellerebbe il marcatore del congedo appena messo, che è quello che tiene il
      // blast del link e il follow-up del B5 lontani da chi si è appena tirato indietro.
      await salvaInfo(info);
      return congedoLancio(supabase, c, testoLead, NOTA_CONGEDO, { testo: TESTO_CONGEDO_POST_PITCH });
    }
    default:
      break;
  }

  // Risposta a una domanda (del percorso o no): la bolla del modello, una sola.
  const testo = (r?.visibleReply ?? '').trim();
  await salvaInfo(info);
  if (!testo) return silenzioLancio(supabase, c, 'risposta_vuota', true);
  if (faseScelta && !info.percorso && eDomandaScelta(testo, modo)) {
    // La domanda della scelta non la scrive piu' il modello: esce come template a
    // pulsanti, col testo FISSO (di notte domanda + spinta). Il modello puo' averla
    // parafrasata o aver perso la spinta: quello che il lead legge lo decide il codice.
    // Dentro un percorso la scelta e' gia' fatta: niente pulsanti.
    const esito = await inviaSceltaLancio(supabase, c, modo);
    await eventoLancio(supabase, c, 'lancio_scelta_pulsanti', { modo, inviato: esito.inviato, ...(esito.motivo ? { motivo: esito.motivo } : {}) }, `[lancio] conv ${c.conversationId}: scelta con pulsanti ${esito.inviato ? 'inviata' : `non inviata (${esito.motivo})`}`, esito.inviato ? 'info' : 'warn');
  } else {
    await inviaBollaLancio(supabase, c, testo);
  }
  await eventoLancio(supabase, c, 'lancio_post_pitch_domanda', { risposte: info.risposte.length, faseScelta, percorso: info.percorso ?? null, domande: info.domande ?? 0 }, `[lancio] conv ${c.conversationId}: post-pitch, ${info.risposte.length} risposte`);
  await tracciaTurnoLancio(supabase, c, 'post_pitch');
  return 'active';
}

/**
 * Fase `scelta_fatta`: la conversazione è `closed`, il webhook la riapre a ogni inbound.
 * Si ringrazia una volta sola (`TESTO_DOPO_SCELTA`), poi silenzio definitivo; le parole
 * del lead vanno sempre al CRM come nota, perché "alle 9 non posso più" lo deve leggere
 * chi lo chiama, non il bot. Stato `closed`: la chat resta ferma finché non riscrive.
 *
 * La finestra vale anche qui: alle 04:00 non si scrive a nessuno e non si lascia la
 * traccia, così il re-drive delle 08:30 rifà il turno — e la nota al CRM parte allora,
 * una volta sola, invece di due (per questo la guardia sta PRIMA della nota).
 */
export async function turnoDopoScelta(
  supabase: Supa,
  i: TurnoLancioInput,
  ctx: { settings: LancioSettings; now: Date },
): Promise<StatoTurno> {
  const c: ContestoTurno = contestoDi(i);
  if (!puoRispondere(ctx.now, eventoAtDa(ctx.settings), 'post_pitch')) {
    return silenzioLancio(supabase, c, 'fuori_orario', false);
  }
  // Tutto quello che ha scritto dopo la nostra ultima bolla, non solo il primo messaggio
  // rimasto senza risposta: "ok" seguito da "alle 9 non posso più" deve arrivare intero
  // a chi lo chiama.
  const parole = testiDelLotto(inboundDelLotto(i.rows)).join(' / ').trim();
  if (parole) {
    // `sendCrmNota` rilegge `crm_lead_id` da sé: nessuna guardia qui, o un lead adottato
    // mentre questo turno girava resterebbe senza le sue parole.
    const nota = await sendCrmNota(supabase, c.conversationId, `Lancio Web Dev AI, dopo la scelta il lead scrive: "${parole.slice(0, MAX_PAROLE_NOTA)}"`);
    if (!nota.sent) {
      await eventoLancio(supabase, c, 'lancio_nota_dopo_scelta_non_inviata', { error: nota.error ?? null, status: nota.status ?? null }, `[lancio] conv ${c.conversationId}: nota dopo la scelta non inviata al CRM`, 'warn');
    }
  }
  const giaDetto = i.rows.some((m) => m.direction === 'out' && (m.body ?? '').trim() === TESTO_DOPO_SCELTA);
  if (giaDetto) {
    await silenzioLancio(supabase, c, 'dopo_scelta', true);
    return 'closed';
  }
  await inviaBollaLancio(supabase, c, TESTO_DOPO_SCELTA);
  await eventoLancio(supabase, c, 'lancio_dopo_scelta', {}, `[lancio] conv ${c.conversationId}: ha scritto dopo la scelta, ringraziato`);
  await tracciaTurnoLancio(supabase, c, 'dopo_scelta');
  return 'closed';
}
