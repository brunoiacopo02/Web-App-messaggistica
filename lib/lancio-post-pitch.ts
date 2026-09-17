import type { getSupabaseAdmin } from './supabase/admin';
import type { Json } from './supabase/types';
import type { LancioSettings } from './lancio-settings';
import type { TurnoLancioInput } from './lancio-turno';
import { generateLancioReply } from './lancio-reply';
import { RISPOSTE_RISCALDAMENTO } from './lancio-prompt';
import { impostaFaseLancio } from './lancio-db';
import { sendCrmNota } from './bot-outcome';
import { pushLeadEntrante } from './lead-entrante';
import { PROVENIENZA_LANCIO_WEBDEV, isMarkerPulsanteWebinar } from './primo-messaggio';
import { haCongedo, paroleDelCongedo, inboundDelLotto, ultimoTestoDelLotto, type RigaLancio } from './lancio-fase';
import { lancioSlots, lancioBook, lancioCallNow, type LancioInfo, type LancioKind } from './lancio-crm';
import { romeDayKey, romeHour } from './rome-time';
import {
  giorniLancio, modoPostPitch, modoEtichette, puoRispondere, validaAtLancio, oreProponibili, testoSlots, bloccoSlotPerPrompt,
  testoConfermaChiamata, testoConfermaPrenotazione, testoOraEsaurita, testoAtNonValido, raccogliRisposte,
  etichettaGiorno,
  type LancioTag,
  TESTO_NESSUN_VENDITORE, TESTO_CHIAMATA_FUORI_ORARIO, TESTO_ERRORE_CRM, TESTO_DOPO_SCELTA, TESTO_CONGEDO_POST_PITCH,
  type OreProponibili, type GiorniLancio, type ModoEtichette,
} from './lancio-scelta';
import {
  congedoLancio, contestoDi, historyDi, eventoAtDa, inviaBollaLancio, inviaSceltaLancio, eventoLancio, tracciaTurnoLancio,
  silenzioLancio, passaggioUmanoLancio, type StatoTurno, type ContestoTurno,
} from './lancio-effetti';
import { eDomandaScelta, tapPulsanteScelta } from './lancio-pulsanti';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export const NOTA_SCELTA = 'Lancio Web Dev AI: ha premuto il pulsante dopo la live.';
/** La stessa provenienza dell'intake (B2): il bucket del lancio sul CRM è uno solo. */
export const PROVENIENZA_LANCIO = PROVENIENZA_LANCIO_WEBDEV;
const NOTA_CONGEDO = 'Lancio Web Dev AI: ha seguito la live ma non vuole una call.';
const NOTA_SENZA_ORE = 'Lancio Web Dev AI: vuole una call ma non ci sono più ore libere nei due giorni dopo la live.';
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
 * Fase `post_pitch` (spec §5.4): il lead ha premuto il pulsante dopo la live. Due domande
 * di riscaldamento (le risposte finiscono in `lancio_info` e poi al venditore), poi la
 * scelta fra "adesso" e "una call". Il modello NON scrive mai un'ora: le ore le elenca il
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
): Promise<StatoTurno> {
  const genera = i.genera ?? generateLancioReply;
  const c = contestoDi(i);
  const now = ctx.now;
  const eventoAt = eventoAtDa(ctx.settings);
  const giorni = giorniLancio(eventoAt);
  const modo = modoPostPitch(now, eventoAt);
  // Come si chiamano i giorni adesso: `modo` dice se la chiamata immediata e' ancora
  // possibile, `etichette` se il 6 e' "domani" o "oggi". Alle 20:40 del 5 sono diversi.
  const etichette = modoEtichette(now, eventoAt);
  // La mattina del giorno dopo si propone da soli finche' siamo nella notte del webinar
  // (fino alle 03:00): e' una decisione di opportunita', non di lessico, e resta attaccata
  // a `modoPostPitch`. Alle 02:00 del 6 la mattina si propone ancora, ma si chiama
  // "stamattina": le due cose divergono e vanno passate separate ai testi.
  const mattinaProponibile = modo === 'notte';

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

  // Fuori orario (03:00-08:30, dopo le 23:00): silenzio TEMPORANEO, senza traccia, così
  // il re-drive di bot-followups delle 08:30 rifà il turno e risponde.
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
  if (testoLead === '') return silenzioLancio(supabase, c, 'inbound_senza_testo', true);

  // Le parole del lead, accumulate (il marker del pulsante no): sono le "info" per chi
  // chiama. Tutto il lotto, non solo l'ultimo: se ha risposto in due messaggi, al
  // venditore devono arrivare entrambi.
  const info: LancioInfo = raccogliRisposte(i.lancioInfo ?? null, testi);
  const faseScelta = info.risposte.length >= RISPOSTE_RISCALDAMENTO || !!info.slotsMostratiAt;

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

  // Le ore si leggono una volta per turno e solo quando servono.
  let ore: OreProponibili | null = null;
  const leggiOre = async (): Promise<OreProponibili> => {
    if (ore) return ore;
    const r = await lancioSlots(giorni.giornoDopo);
    if (!r.ok) {
      await eventoLancio(supabase, c, 'lancio_slots_non_letti', { motivo: r.motivo }, `[lancio] conv ${c.conversationId}: slot non letti dal CRM (${r.motivo}), propongo pomeriggio e dopodomani`, 'warn');
    }
    ore = oreProponibili(r.ok ? r.slots : null, now, eventoAt);
    return ore;
  };

  /** Come si compone il testo con le ore: etichette dei giorni e permesso di proporre la
   *  mattina viaggiano insieme, cosi' ogni variante (nessun venditore, ora esaurita, ora
   *  non valida) li riceve tutti e due senza doverli ricordare. */
  type ComponiTesto = (o: OreProponibili, g: GiorniLancio, m: ModoEtichette, mattinaOk: boolean) => string;

  /** Manda un testo con le ore (scritto dal codice) e segna che le ore sono state mostrate. */
  const mostraOre = async (componi: ComponiTesto = testoSlots): Promise<'active'> => {
    const o = await leggiOre();
    await inviaBollaLancio(supabase, c, componi(o, giorni, etichette, mattinaProponibile));
    await salvaInfo({ ...info, slotsMostratiAt: now.toISOString() });
    if (o.mattina.length === 0 && o.pomeriggio.length === 0 && o.dopodomani.length === 0) {
      // Nessuna ora proposta: `lancio_slots_mostrati` direbbe il falso, e chi conta le
      // ore mostrate la sera del lancio conterebbe un turno in cui non ce n'era nessuna.
      // Il testo promette "lascio nota": la nota parte davvero, altrimenti nessuno lo
      // richiama. `sendCrmNota` rilegge da sé `crm_lead_id`, quindi non si filtra qui:
      // un lead adottato dentro questo turno la nota la deve avere lo stesso.
      const nota = await sendCrmNota(supabase, c.conversationId, NOTA_SENZA_ORE);
      await eventoLancio(supabase, c, 'lancio_slots_vuoti', { notaInviata: nota.sent, errore: nota.error ?? null }, `[lancio] conv ${c.conversationId}: nessuna ora libera nei due giorni, nota al CRM`, 'warn');
    } else {
      await eventoLancio(supabase, c, 'lancio_slots_mostrati', { mattina: o.mattina, pomeriggio: o.pomeriggio, dopodomani: o.dopodomani, modo, etichette, mattinaProponibile }, `[lancio] conv ${c.conversationId}: ore proposte`);
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

  // Con un tocco la scelta e' gia' fatta: niente prompt, niente ore nel prompt, niente
  // chiamata al modello. E' anche il turno piu' veloce della serata, che e' esattamente
  // quando la coda dei post-pitch e' piu' lunga.
  const bloccoSlot = faseScelta && !tap ? bloccoSlotPerPrompt(await leggiOre(), giorni, etichette, mattinaProponibile) : null;
  const r = tap
    ? null
    : await genera(historyDi(i.rows), {
        fase: 'post_pitch', nome: i.nome, eventoAt: ctx.settings.eventoAt, now,
        modo, risposteRaccolte: info.risposte.length, bloccoSlot,
      });

  if (r?.passToHuman) {
    await salvaInfo(info);
    return passaggioUmanoLancio(supabase, c, r.visibleReply, testoLead);
  }

  if (tap) {
    await eventoLancio(supabase, c, 'lancio_scelta_pulsante_tap', { titolo: testoLead, tag: tap, modo }, `[lancio] conv ${c.conversationId}: pulsante "${testoLead}" -> ${tap}`);
  }
  // Il tocco vale come il tag che il modello avrebbe scritto: da qui in giu' il flusso e'
  // lo stesso di sempre, regole dure comprese (di giorno CHIAMA_ORA diventa il testo fisso
  // "a quest'ora fissiamo la call" piu' le ore, come oggi).
  const tag: LancioTag | null = tap ? (tap === 'CHIAMA_ORA' ? { tag: 'CHIAMA_ORA' } : { tag: 'SLOTS' }) : r!.lancioTag;
  switch (tag?.tag) {
    case 'CHIAMA_ORA': {
      // Regola dura: la chiamata immediata esiste solo la notte del webinar.
      if (modo !== 'notte') return mostraOre((o, g, m, mattinaOk) => `${TESTO_CHIAMATA_FUORI_ORARIO} ${testoSlots(o, g, m, mattinaOk)}`);
      const leadId = await leadIdPerCrm();
      if (!leadId) return erroreCrm('lancio_lead_senza_crm', { tag: 'CHIAMA_ORA' });
      const esito = await lancioCallNow({ leadId, info: { risposte: info.risposte }, note: NOTA_SCELTA });
      if (esito.ok) {
        await inviaBollaLancio(supabase, c, testoConfermaChiamata(esito.venditore.nome));
        return sceltaFatta('chiama_ora', { venditore: esito.venditore });
      }
      if (esito.motivo === 'gia_prenotato') return giaPrenotato(esito, 'CHIAMA_ORA');
      if (esito.motivo === 'nessun_venditore') return mostraOre((o, g, m, mattinaOk) => `${TESTO_NESSUN_VENDITORE} ${testoSlots(o, g, m, mattinaOk)}`);
      // `conflitto` compreso: il client l'ha già ritentato una volta, qui si dice al lead
      // di riscrivere invece di martellare il CRM dentro il turno.
      return erroreCrm('lancio_crm_errore', { tag: 'CHIAMA_ORA', ...esito });
    }
    case 'PRENOTA': {
      const v = validaAtLancio(tag.at, now, eventoAt);
      if (!v.ok) {
        await eventoLancio(supabase, c, 'lancio_at_non_valido', { at: tag.at, motivo: v.motivo }, `[lancio] conv ${c.conversationId}: ora ${tag.at} rifiutata (${v.motivo})`);
        return mostraOre(testoAtNonValido);
      }
      const leadId = await leadIdPerCrm();
      if (!leadId) return erroreCrm('lancio_lead_senza_crm', { tag: 'PRENOTA', at: tag.at });
      const esito = await lancioBook({ leadId, at: tag.at, info: { risposte: info.risposte }, note: NOTA_SCELTA });
      if (esito.ok) {
        await inviaBollaLancio(supabase, c, testoConfermaPrenotazione(esito.kind, tag.at, esito.venditore?.nome ?? null));
        return sceltaFatta('prenota', { at: tag.at, kind: esito.kind, venditore: esito.venditore ?? null, deduped: esito.deduped === true });
      }
      if (esito.motivo === 'gia_prenotato') return giaPrenotato(esito, 'PRENOTA');
      if (esito.motivo === 'ora_esaurita') {
        // Le ore aggiornate sono nella risposta: si ripropone da quelle, non da quelle di
        // prima. `esito.slots` è già `LancioSlots | null` letto dal client: niente cast.
        ore = oreProponibili(esito.slots, now, eventoAt);
        return mostraOre((o, g, m, mattinaOk) => testoOraEsaurita(v.hour, o, g, m, mattinaOk));
      }
      if (esito.motivo === 'nessun_venditore') return mostraOre((o, g, m, mattinaOk) => `${TESTO_NESSUN_VENDITORE} ${testoSlots(o, g, m, mattinaOk)}`);
      if (esito.motivo === 'fuori_regole') {
        await eventoLancio(supabase, c, 'lancio_at_non_valido', { at: tag.at, motivo: 'crm_fuori_regole' }, `[lancio] conv ${c.conversationId}: il CRM rifiuta ${tag.at} (422)`, 'warn');
        return mostraOre(testoAtNonValido);
      }
      return erroreCrm('lancio_crm_errore', { tag: 'PRENOTA', at: tag.at, ...esito });
    }
    case 'SLOTS':
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
    default: {
      // Riscaldamento o risposta a una domanda: la bolla del modello, una sola.
      const testo = (r?.visibleReply ?? '').trim();
      await salvaInfo(info);
      if (!testo) return silenzioLancio(supabase, c, 'risposta_vuota', true);
      if (faseScelta && eDomandaScelta(testo, modo)) {
        // La domanda della scelta non la scrive piu' il modello: esce come template a
        // pulsanti, col testo FISSO (di notte domanda + spinta). Il modello puo' averla
        // parafrasata o aver perso la spinta: quello che il lead legge lo decide il codice.
        const esito = await inviaSceltaLancio(supabase, c, modo);
        await eventoLancio(supabase, c, 'lancio_scelta_pulsanti', { modo, inviato: esito.inviato, ...(esito.motivo ? { motivo: esito.motivo } : {}) }, `[lancio] conv ${c.conversationId}: scelta con pulsanti ${esito.inviato ? 'inviata' : `non inviata (${esito.motivo})`}`, esito.inviato ? 'info' : 'warn');
      } else {
        await inviaBollaLancio(supabase, c, testo);
      }
      await eventoLancio(supabase, c, 'lancio_post_pitch_domanda', { risposte: info.risposte.length, faseScelta }, `[lancio] conv ${c.conversationId}: post-pitch, ${info.risposte.length} risposte`);
      await tracciaTurnoLancio(supabase, c, 'post_pitch');
      return 'active';
    }
  }
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
