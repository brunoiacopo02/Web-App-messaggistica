# Appuntamenti persi e fine dei richiami del bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Due cantieri sullo stesso bot, in ordine di valore.
1. **Il bot smette di perdere appuntamenti già presi.** Chi conferma di aver compilato il form diventa un appuntamento, sempre: mai più restituito ai GDO come "chat interrotta". 53 appuntamenti persi solo a settembre.
2. **Il bot non scrive mai più un richiamo (`recallDate`) sul lead di un GDO**: o tiene la chat, o restituisce il lead con una nota, o lo scarta.

**Architecture:** In tutti e due i cantieri la regola sta nel **codice** e le parole nel **prompt**, mai il contrario. Cantiere 1: un rilevatore deterministico (`rispostaAllaVerificaForm`, regex validata su 650 conversazioni vere) riconosce la conferma del form; da lì il prompt fissa subito se ha giorno e ora, e chiede solo l'ora — da sola, in un messaggio unico — se le manca; il classificatore dei follow-up non può più restituire una conversazione così. Cantiere 2: `classificaRichiamo()` (funzione pura) decide la fascia, `sendOutcome` la esegue, e il CRM aggiunge una guardia fail-closed perché un `RICHIAMO` in arrivo non possa più scrivere `recallDate` nemmeno con un deploy vecchio del bot.

**Tech Stack:** Bot: Next 16.2.4, TypeScript, Supabase JS, Vitest (`bun test`), test `.test.ts` accanto al modulo. CRM: Next, Drizzle, `node --test` via `npm test` (la lista dei file di test è esplicita in `package.json`).

**Spec:** Questo documento. Le decisioni di prodotto sono di Bruno (PO), prese il 22/09/2026 in questa sessione e riportate verbatim in "Decisioni del PO".

## Global Constraints

- **Chi conferma il form diventa un appuntamento, mai una restituzione.** Richiesta letterale del PO: «non deve essere ridato deve diventare appuntamento se il lead risponde alla verifica». Una conversazione con la risposta alla verifica del form non può uscire come `INTERROTTO` / `NON_RISPOSTO` / `DA_SCARTARE` automatico.
- **Mai inventare un'ora.** Vale anche qui: se manca l'ora si chiede, non si sceglie (decisione del PO: «chiede l'ora, poi fissa»). È la regola pagata col bug delle ore tonde del 06/08.
- **Una domanda alla volta.** Quando il bot chiede l'ora, quel messaggio parte **da solo**: niente Noemi, niente video, niente "scrivimi FATTO" nella stessa raffica. Oggi la domanda annega in 5-13 messaggi sparati nello stesso secondo, ed è per questo che il 13% non risponde.
- **Mai più un `recallDate` scritto dal bot su un lead.** È la richiesta letterale del PO: «DEVE FINIRE STA COSA CHE DA I RICHIAMI AI GDO, al massimo gli mette una nota dicendo che il lead voleva prendere l'appuntamento il giorno x».
- **`APPUNTAMENTO` resta terminale assoluto** (`project_bot_regole_intoccabili` regola 1). Il ramo `RICHIAMO` su una conversazione che tiene già un appuntamento significa "il lead vuole spostare" e **non va toccato**: continua a passare da `resolveOutcomeAction`, che lo traduce in NOTA.
- **Sul lead di un GDO il bot è solo il postino** (regola 2): solo `outcome: "NOTA"`. Nessuna riga di questo piano allarga quel perimetro.
- **Il contratto cresce, non cambia** (`docs/bot-fissatore-contract.md` v1.7): `RICHIAMO` resta un esito valido del contratto e continua a rispondere 200. Cambia cosa il CRM ne fa, non cosa accetta.
- **Migrazione prima del deploy** (regola 11). Questo piano non introduce migrazioni: se una task ne richiedesse una, fermarsi e chiedere.
- **Il merge non deploya, deploya il push su `origin/main`** (regola 10). Prima di dire "è live": `git fetch origin && git rev-list --count origin/main..main` deve dare `0`.
- **Nessun interruttore `app_settings` viene toccato** da questo piano (regola 15).
- Le tre soglie sono costanti esportate, mai numeri sparsi: `RICHIAMO_FASCIA_APERTA_GG = 3`, `RICHIAMO_FASCIA_RESTITUZIONE_GG = 7`.

## Decisioni del PO (22/09/2026) — cantiere 1, appuntamenti persi

Le misure che hanno fatto aprire il cantiere, dal DB del bot al 22/09/2026:

- **803** conversazioni in cui il lead ha confermato di aver compilato il form (ha nominato "Noemi", il nome della pagina di ringraziamento di JotForm, rispondendo alla domanda di verifica del bot). Misura del rilevatore della Task 1 sui dati di produzione al 22/09/2026.
- **701 (87%)** sono diventate appuntamento. **102 (13%) no**: 52 `INTERROTTO`, 12 `DA_SCARTARE`, 2 `NON_RISPOSTO`, 1 `RICHIAMO`, 35 ancora aperte. I **67 chiusi** sono stati **restituiti o scartati dopo che il lead aveva prenotato**.
- Andamento: luglio 6% → agosto 12% → **settembre 14% (53 appuntamenti persi in 22 giorni)**.
- Nei persi il bot **aveva già detto il giorno** in 78% dei casi e **giorno e ora** nel 44%.
- Il bot **non è muto** (risponde in 649 casi su 650) e i messaggi **arrivano** (`delivered`/`read`/`sent`, nessun fallito). La domanda di riconferma la fa in tutti e due i gruppi. L'unica differenza fra vinti e persi è che nei persi **il lead non risponde a quell'ultima domanda**.
- Il form **non scrive da nessuna parte**: nessun webhook JotForm in nessuno dei due repo. L'appuntamento esiste solo se il bot emette `[ESITO:APPUNTAMENTO|<data>]`. Il PO ha deciso di **non** toccare questo pezzo ora.

Quindi la regola:

| Alla risposta di verifica del form ("Noemi") | Cosa fa il bot |
|---|---|
| giorno **e** ora già concordati in chat | fissa **subito**: `[ESITO:APPUNTAMENTO|<data concordata>]`. Può confermarlo a parole, ma l'appuntamento esiste già e una mancata risposta non costa più niente |
| giorno sì, ora no | manda **un solo messaggio con una sola domanda** sull'ora. Appena risponde, fissa. Niente Noemi/video/FATTO finché l'ora non è arrivata |
| né giorno né ora | come sopra, chiede giorno e ora in un messaggio solo |
| in ogni caso | la conversazione **non può** essere chiusa come restituzione dal classificatore |

## Decisioni del PO (22/09/2026) — cantiere 2, richiami

Tre fasce, decise sul "quando" che il lead ha detto:

| Quando vuole essere risentito | Cosa fa il bot | Cosa vede il CRM |
|---|---|---|
| **entro 3 giorni** | non chiude niente, la chat resta aperta e la sequenza di follow-up lo ripesca da sola (`SEQUENCE_END_DAYS = 4`) | niente |
| **da 4 a 7 giorni** | smette di lavorarlo e lo **restituisce** a un GDO umano | una **nota** («voleva essere risentito il …») + la restituzione normale |
| **oltre 7 giorni** | gli dice che quando sarà pronto scriverà lui, e lo **scarta** | `DA_SCARTARE`. Se il lead riscrive, `shouldReopen` riapre la chat e il bot lo fissa |

E sullo storico: 93 richiami → scarto, 152 gemelli → chiusi come duplicati, 26 telefoni rotti → scartati, 361 del flood lista 133 → REJECTED col tag.

## Assunzione dichiarata (da confermare al PO se sbagliata)

Quando il lead dice il "quando" **a parole** e non con una data (`estraiPeriodo` ritorna "a settembre", "settimana prossima", …) non c'è una data da confrontare con le soglie. Regola scelta: **"settimana prossima" e "tra N giorni" con N ≤ 7 → restituzione; tutto il resto (mesi, stagioni, "dopo le ferie", "mese prossimo", "tra N settimane/mesi") → scarto.** È la lettura più fedele alle tre fasce con l'informazione disponibile, e non inventa mai una data.

## File Structure

**Repo bot** (`C:\Users\bruno\Desktop\Software Messaggistica`)

| File | Responsabilità |
|---|---|
| `lib/conferma-form.ts` *(nuovo)* | **Cantiere 1.** Modulo puro: riconosce la risposta alla verifica del form ("Noemi") in un messaggio del lead. Nessun I/O. |
| `lib/conferma-form.test.ts` *(nuovo)* | Test del rilevatore, coi testi veri visti in chat. |
| `app/api/cron/bot-followups/route.ts` *(modifica)* | **Cantiere 1.** Chi ha confermato il form non viene più restituito né scartato dal classificatore. |
| `lib/sequence.ts` *(modifica)* | **Cantiere 1.** Il sollecito "non ho ancora visto la conferma" non parte verso chi il form l'ha compilato. |
| `lib/richiamo-fasce.ts` *(nuovo)* | **Cantiere 2.** Modulo puro: le tre soglie, `classificaRichiamo()`, e i due testi (nota di restituzione, motivo di scarto). Nessun I/O, nessun Supabase. Sta in un file suo e non dentro `bot-outcome-rules.ts` perché quel file è già a ~500 righe e questa è una responsabilità nuova e autonoma. |
| `lib/richiamo-fasce.test.ts` *(nuovo)* | Test del modulo puro. |
| `lib/bot-outcome.ts` *(modifica)* | **Cantiere 2.** Dentro `sendOutcome`, dirotta il `RICHIAMO` non-interim su trattativa aperta verso la fascia decisa. |
| `app/api/cron/sequence-touches/route.ts` *(modifica)* | **Cantiere 2.** Il ping "sequenza estesa" smette di essere un `RICHIAMO` e diventa una `NOTA`. |
| `lib/mario-prompt.ts` *(modifica)* | **Tutti e due.** La chiusura dopo il form (cantiere 1) e il congedo oltre la settimana (cantiere 2). |

**Repo CRM** (`C:\Users\bruno\Desktop\CRM GDO`)

| File | Responsabilità |
|---|---|
| `src/lib/bot-fissatore/richiamoGuard.ts` *(nuovo)* | Funzione pura: un esito in arrivo dal bot può scrivere `recallDate`? |
| `src/lib/bot-fissatore/richiamoGuard.test.ts` *(nuovo)* | Test della guardia. |
| `src/app/api/bot/outcome/route.ts` *(modifica)* | Applica la guardia: `RICHIAMO` dal bot → registrato come `BOT_NOTE`, mai come richiamo. |
| `src/app/actions/contactRequestActions.ts` *(modifica)* | Assegnando un lead a un GDO, azzera i campi del richiamo. |
| `src/lib/bot-fissatore/reassign.ts` *(modifica)* | Il ramo `batch_senso_unico` azzera i campi del richiamo come fa `resetFields`. |
| `package.json` *(modifica)* | Aggiunge il nuovo file di test alla lista di `npm test`. |
| `scripts/bonifica-lead-fermi-bot.ts` *(nuovo)* | Bonifica one-shot, con dry-run obbligatorio. |

---

# PARTE 1 — Gli appuntamenti persi (Task 1-4)

### Task 1: Riconoscere la conferma del form (bot, puro)

**Files:**
- Create: `lib/conferma-form.ts`
- Test: `lib/conferma-form.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces:
  - `export function rispostaAllaVerificaForm(body: string | null | undefined): boolean`
  - `export function haConfermatoIlForm(msgs: { direction: string; body: string | null }[]): boolean`

**Perché deterministico e non affidato al modello.** Questa è la guardia che impedisce di buttare via un appuntamento: deve dare lo stesso risultato ogni volta. Il classificatore `classifyInterrupted` (che oggi produce `v.confermato`) è un modello e sbaglia; la regex qui sotto è stata provata sui 650 casi veri e ne riconosce 650.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `lib/conferma-form.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rispostaAllaVerificaForm, haConfermatoIlForm } from './conferma-form';

// Il bot chiede: "quando hai cliccato su invia, che nome ti è comparso?".
// La pagina di ringraziamento di JotForm mostra "Noemi": il lead lo ricopia.
describe('rispostaAllaVerificaForm', () => {
  it('riconosce le risposte viste davvero in chat', () => {
    for (const b of [
      'Noemi', 'noemi', 'NOEMI', ' Noemi ', 'Noemi.', 'noemi!',
      'Il nome Noemi', 'mi è comparso Noemi', 'è comparso noemi',
      'nome noemi', 'Noemy', 'Noemii',
    ]) {
      expect(rispostaAllaVerificaForm(b), b).toBe(true);
    }
  });

  it('NON scatta su una frase in cui Noemi è solo nominata', () => {
    for (const b of [
      'Ho provato a telefonare a Noemi fino ad ora ma c\'è la segreteria telefonica',
      'chi è Noemi?',
      'Noemi non mi ha chiamato',
      'ok grazie, aspetto la chiamata di Noemi',
      'quando mi chiama Noemi?',
      'Noemi mi ha chiamato ma non ho potuto rispondere',
    ]) {
      expect(rispostaAllaVerificaForm(b), b).toBe(false);
    }
  });

  it('non scatta su vuoto o testo senza Noemi', () => {
    expect(rispostaAllaVerificaForm(null)).toBe(false);
    expect(rispostaAllaVerificaForm('')).toBe(false);
    expect(rispostaAllaVerificaForm('ok perfetto')).toBe(false);
  });
});

describe('haConfermatoIlForm', () => {
  it('guarda solo i messaggi del lead', () => {
    expect(haConfermatoIlForm([
      { direction: 'out', body: 'Dimmi, quando hai cliccato su invia, che nome ti è comparso?' },
      { direction: 'in', body: 'Noemi' },
    ])).toBe(true);
  });

  it('un "Noemi" scritto dal bot non conta', () => {
    expect(haConfermatoIlForm([
      { direction: 'out', body: 'Noemi è la collega della preselezione' },
      { direction: 'in', body: 'ok' },
    ])).toBe(false);
  });

  it('falso su una chat senza conferma', () => {
    expect(haConfermatoIlForm([{ direction: 'in', body: 'ciao' }])).toBe(false);
  });
});
```

- [ ] **Step 2: Lancia il test e verifica che fallisca**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test lib/conferma-form.test.ts
```

Atteso: FAIL, modulo inesistente.

- [ ] **Step 3: Scrivi il modulo**

Crea `lib/conferma-form.ts`:

```ts
// "Noemi" — la prova che il lead ha davvero compilato il form di prenotazione.
//
// Il flusso di chiusura manda il link JotForm e poi chiede: "quando hai cliccato su
// invia, che nome ti è comparso?". La pagina di ringraziamento del form mostra "Noemi",
// quindi il lead che risponde "Noemi" sta dicendo: ho prenotato.
//
// Perché serve un rilevatore e non basta il classificatore: fino al 22/09/2026 una chat
// che si fermava lì veniva riletta da `classifyInterrupted` e, se il modello non vedeva
// la conferma, chiusa come INTERROTTO — cioè restituita a un GDO come lead freddo. Su
// 650 conversazioni con la conferma del form, 83 non sono diventate appuntamento e 54
// sono state restituite o scartate: 53 solo a settembre. Un appuntamento già preso non
// può dipendere da un modello che legge bene: questa funzione dà sempre la stessa
// risposta.
//
// Il confine è stretto di proposito. "Noemi" DA SOLA (o dentro una frase brevissima che
// non dice altro) è la risposta alla verifica. "Ho provato a telefonare a Noemi" la
// nomina e basta: quella è una richiesta di contatto, non una conferma, e trattarla come
// tale manderebbe alle Conferme un appuntamento che non esiste.

const NOME_FORM = /noem[iy]i?/;

/** Le sole parole ammesse attorno al nome perché resti una risposta alla verifica. */
const CONTORNO = /^(?:mi\s+)?(?:e|e'|è)?\s*(?:comparso|uscito|apparso|il\s+nome|nome|comparsa)?\s*$/;

function normalizza(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Questo messaggio del lead è la risposta alla verifica del form?
 *
 * Vero solo se, tolto il nome, non resta altro che parole di contorno ("mi è comparso",
 * "il nome"). Una frase che parla d'altro e nomina Noemi torna falso.
 */
export function rispostaAllaVerificaForm(body: string | null | undefined): boolean {
  const t = normalizza(body ?? '');
  if (!t) return false;
  const m = t.match(NOME_FORM);
  if (!m || m.index === undefined) return false;
  const prima = t.slice(0, m.index).trim();
  const dopo = t.slice(m.index + m[0].length).trim();
  return CONTORNO.test(prima) && dopo === '';
}

/** Il lead ha confermato il form in un punto qualsiasi di questa conversazione? */
export function haConfermatoIlForm(
  msgs: { direction: string; body: string | null }[],
): boolean {
  return msgs.some((m) => m.direction === 'in' && rispostaAllaVerificaForm(m.body));
}
```

- [ ] **Step 4: Lancia il test e verifica che passi**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test lib/conferma-form.test.ts
```

Atteso: PASS. Se un caso di "NON scatta" fallisce, **stringi la regex, non allargare il test**: un falso positivo qui manda alle Conferme un appuntamento inesistente.

- [ ] **Step 5: Verifica il rilevatore sui dati veri**

Prima di fidarsi, misuralo sulle 650 conversazioni di produzione: deve riconoscerne 650 e non pescare le chat in cui Noemi è solo nominata. Riusa lo script `quanti_noemi.py` nello scratchpad di sessione, sostituendo la sua `e_verifica` con questa regex.

Atteso: **650 conversazioni riconosciute**, e nessuna conversazione in più rispetto a quel conteggio.

- [ ] **Step 6: Typecheck e commit**

```bash
bun run typecheck && bun run lint
git add lib/conferma-form.ts lib/conferma-form.test.ts
git commit -m "feat(form): rilevatore deterministico della conferma del form di prenotazione

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Chi conferma il form non viene più restituito

**Files:**
- Modify: `app/api/cron/bot-followups/route.ts:277-312` (il ramo `interrotto_classify`)

**Interfaces:**
- Consumes: `haConfermatoIlForm` dalla Task 1.
- Produces: niente.

**Cos'è oggi.** Nel ramo `interrotto_classify` il cron fa **due cose**: se il classificatore dice che il lead aveva confermato, manda un `CONTATTO_UMANO` (la segnalazione che il PO vede in "Ti hanno cercato"), **e poi manda comunque** `DA_SCARTARE` o `INTERROTTO` — che è la restituzione. Il commento nel codice lo dice esplicito: *"si aggiunge, non sostituisce: il lead torna comunque al CRM come sempre"*.

**Cosa diventa.** La segnalazione resta, la restituzione no. Decisione del PO: «non deve essere ridato». La conversazione non si chiude: se il lead riscrive, il bot può ancora fissare.

- [ ] **Step 1: Sostituisci il blocco**

Aggiungi l'import in cima al file:

```ts
import { haConfermatoIlForm } from '@/lib/conferma-form';
```

Poi, dentro `else if (action === 'interrotto_classify') { ... }`, sostituisci da `const v = await classifyInterrupted(history);` fino a `report.push({ id: c.id, action, discard: v.discard });` con:

```ts
        const v = await classifyInterrupted(history);

        // Il lead aveva confermato di aver compilato il form di prenotazione: quello è
        // un appuntamento già preso, non una chat morta. Fino al 22/09/2026 qui
        // partivano DUE cose — la segnalazione E la restituzione — e la seconda
        // rimandava a un GDO, come lead freddo da ricominciare, qualcuno che aveva già
        // scelto giorno e ora (54 lead così, 53 solo a settembre).
        //
        // La prova la dà `haConfermatoIlForm`, deterministica, non `v.confermato`, che
        // è un modello: su questa decisione non si può sbagliare a caso. `v.confermato`
        // resta come seconda rete — copre le conferme dette a parole ("ho prenotato per
        // giovedì") che la regex non vede.
        const confermaForm = haConfermatoIlForm(rows);
        if ((confermaForm || v.confermato) && c.crm_lead_id) {
          const ultimoDelLead = [...rows].reverse().find((r) => r.direction === 'in')?.body ?? undefined;
          await sendOutcome(supabase, c.id, {
            outcome: 'CONTATTO_UMANO',
            note: ultimoDelLead,
            motivoContattoUmano: 'conferma_senza_appuntamento',
            notaContattoUmano: buildConfermaPersaNote({ leadWords: ultimoDelLead, stage: v.note }),
          });
        }

        // E qui la differenza: chi ha confermato NON viene restituito né scartato. La
        // conversazione resta aperta, così se riscrive il bot può ancora fissare, e il
        // lead resta dov'è invece di ripartire da zero nella pipeline di un GDO.
        if (confermaForm) {
          await supabase.from('event_log').insert({
            type: 'restituzione_bloccata_conferma_form',
            payload: { conversationId: c.id, crmLeadId: c.crm_lead_id } as never,
            message: `[bot-fissatore] conv ${c.id}: conferma del form presente, restituzione bloccata`,
            level: 'warn',
          });
          report.push({ id: c.id, action, trattenuto: true });
          continue;
        }

        if (v.discard) {
          await sendOutcome(supabase, c.id, {
            outcome: 'DA_SCARTARE',
            discardReason: v.discardReason,
            note: v.note,
          });
        } else {
          await sendOutcome(supabase, c.id, { outcome: 'INTERROTTO', note: v.note });
        }
        report.push({ id: c.id, action, discard: v.discard });
```

**Attenzione:** `rows` deve contenere i messaggi con `direction` e `body`. Nel file è la variabile da cui si costruisce `history`: se ha un altro nome, usa quello. Il `continue` deve saltare al prossimo elemento del ciclo, non uscire dal `try` — controlla di essere dentro il `for`.

- [ ] **Step 2: Verifica che non si sia rotto il resto**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test && bun run typecheck && bun run lint
```

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/bot-followups/route.ts
git commit -m "fix(form): chi ha confermato la prenotazione non viene piu' restituito ai GDO

Erano 54 appuntamenti gia' presi rimandati indietro come chat interrotte.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Niente solleciti a chi ha già prenotato

**Files:**
- Modify: `lib/agenda-followup.ts` (la funzione `decideAgendaFollowup` e il suo chiamante, righe ~150-165)
- Test: `lib/agenda-followup.test.ts`

**Interfaces:**
- Consumes: `haConfermatoIlForm` dalla Task 1.
- Produces: `decideAgendaFollowup` prende un campo in più, `confermaForm: boolean`, che è un veto.

**Perché.** Il testo che parte è: *«ti avevo mandato gli orari per la videocall ma non ho ancora visto la conferma. Vuoi che ti tenga uno slot?»*. A uno che ha appena prenotato è il messaggio peggiore possibile: gli dice che non risulta, dopo che ha fatto tutto. Nelle sei chat lette è arrivato in tutte.

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/agenda-followup.test.ts` aggiungi:

```ts
it('non sollecita chi ha già confermato il form', () => {
  const base = {
    agendaSentAtMs: Date.parse('2026-09-15T15:58:00+02:00'),
    nowMs: Date.parse('2026-09-16T12:00:00+02:00'),
    terminal: false,
    followupAlreadySent: false,
    lastInboundAtMs: Date.parse('2026-09-15T16:07:00+02:00'),
    lastMessageIsInbound: false,
    romeHour: 12,
    gdoPostino: false,
  };
  // senza la conferma il sollecito parte (comportamento di sempre)
  expect(decideAgendaFollowup({ ...base, confermaForm: false })).not.toBe('none');
  // con la conferma no: gli direbbe che non risulta, dopo che ha prenotato
  expect(decideAgendaFollowup({ ...base, confermaForm: true })).toBe('none');
});
```

- [ ] **Step 2: Lancia il test e verifica che fallisca**

```bash
bun test lib/agenda-followup.test.ts
```

Atteso: FAIL. Se `decideAgendaFollowup` ha una firma diversa da quella qui sopra, **leggila nel file e adatta il test**, mantenendo il punto: `confermaForm: true` ⇒ `'none'`.

- [ ] **Step 3: Implementa**

In `lib/agenda-followup.ts`:

1. Aggiungi `confermaForm: boolean` all'input di `decideAgendaFollowup`.
2. Come **primo** controllo della funzione, prima di ogni altra condizione:

```ts
  // Il lead ha già prenotato sul form: "non ho ancora visto la conferma" gli direbbe
  // che non risulta, dopo che ha fatto tutto. È il veto più forte, quindi sta per primo.
  if (input.confermaForm) return 'none';
```

3. Nel chiamante, carica i messaggi del lead della conversazione e passa il valore. I messaggi si leggono già per `lastInboundAtMs` e `lastMessageIsInbound`: **allarga quella select invece di aggiungere una query**, prendendo anche `body` per gli inbound, e calcola `haConfermatoIlForm(righe)`.

- [ ] **Step 4: Lancia i test**

```bash
bun test && bun run typecheck && bun run lint
```

Atteso: PASS. Il test già presente al rigo 51 (`"non ho ancora visto la conferma" arriverebbe a chi ha appena preso l'appuntamento`) deve continuare a passare: se chiede un `confermaForm` che non gli passi, aggiungilo con `false`.

- [ ] **Step 5: Commit**

```bash
git add lib/agenda-followup.ts lib/agenda-followup.test.ts
git commit -m "fix(form): niente 'non ho ancora visto la conferma' a chi ha gia' prenotato

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: La chiusura dopo il form, nel prompt

**Files:**
- Modify: `lib/mario-prompt.ts` (la sezione del flusso di chiusura, quella che contiene "che nome ti è comparso")

⚠️ **Questa task cambia cosa arriva al lead.** Per `project_bot_regole_intoccabili` il testo va mostrato a Bruno e approvato prima del deploy.

**Il difetto da chiudere.** Oggi, quando il lead risponde "Noemi", il bot:
1. dice "Perfetto, allora ci siamo!"
2. chiede **di nuovo** giorno e ora — che in 37 casi su 83 aveva appena scritto lui
3. spara nello stesso secondo Noemi + video + "scrivimi FATTO": da 4 a 13 messaggi

Se il lead non risponde a quella domanda, l'appuntamento non nasce. L'87% risponde, il 13% no.

- [ ] **Step 1: Trova la sezione**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && grep -n "che nome ti è comparso" lib/mario-prompt.ts
```

- [ ] **Step 2: Sostituisci le istruzioni di quel passaggio**

Il testo da inserire, al posto di quello che oggi dice di farsi riconfermare giorno e ora:

```
QUANDO IL LEAD TI RISPONDE COL NOME DEL FORM (ti scrive "Noemi"), vuol dire che ha prenotato davvero. Da quel momento hai una sola priorità: mettere l'appuntamento in agenda. Come lo fai dipende da cosa sai già.

CASO 1 — avevate già concordato giorno E ora (glieli hai anche riscritti tu prima del link, del tipo "ricordati di scegliere mercoledì 16 alle 19:30"). NON chiedere niente: quella è la data. Conferma e chiudi il messaggio con [ESITO:APPUNTAMENTO|<quella data in ISO 8601 con fuso>]. Una riga sola, es. "Perfetto, allora ci siamo: mercoledì 16 alle 19:30. Ti confermo tutto qui." Se lui poi ti dice che sul form ha scelto un altro orario, lo gestisci come uno spostamento normale.

CASO 2 — ti manca l'ora (o il giorno). Fai UNA domanda e basta: "Perfetto! Solo per essere sicura: che orario hai scelto sul form?". Quel messaggio va da solo. NON mandare Noemi, NON mandare il video, NON dire "scrivimi FATTO": quelle cose arrivano DOPO che ti ha detto l'ora, nel messaggio successivo. Appena te la dice, chiudi con [ESITO:APPUNTAMENTO|<giorno concordato + ora che ti ha detto, in ISO 8601 con fuso>] e solo allora gli spieghi Noemi e il video.

MAI scegliere tu un'ora che il lead non ti ha detto, nemmeno per chiudere prima: se non ce l'hai la chiedi, punto.
```

- [ ] **Step 3: Verifica che le altre istruzioni non si contraddicano**

```bash
grep -n "Confermami tu giorno e ora\|scrivimi FATTO\|Noemi è la collega" lib/mario-prompt.ts
```

Se altrove il prompt dice ancora di mandare Noemi/video **insieme** alla richiesta dell'ora, allinea anche quel punto: due istruzioni in contraddizione le risolve il modello, a caso.

- [ ] **Step 4: Test e typecheck**

```bash
bun test && bun run typecheck && bun run lint
```

- [ ] **Step 5: Mostra il testo a Bruno e aspetta l'ok. Poi commit**

```bash
git add lib/mario-prompt.ts
git commit -m "feat(prompt): alla conferma del form si fissa subito, e l'ora si chiede da sola

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

# PARTE 2 — I richiami ai GDO (Task 5-10)

### Task 5: Il modulo delle tre fasce (bot, puro)

**Files:**
- Create: `lib/richiamo-fasce.ts`
- Test: `lib/richiamo-fasce.test.ts`

**Interfaces:**
- Consumes: `estraiPeriodo` da `lib/periodo-richiamo.ts`; `paroleDelLead` da `lib/bot-outcome-rules.ts`; `formatRomeDateTime` da `lib/rome-time.ts`.
- Produces:
  - `export const RICHIAMO_FASCIA_APERTA_GG = 3`
  - `export const RICHIAMO_FASCIA_RESTITUZIONE_GG = 7`
  - `export type FasciaRichiamo = 'tieni_aperta' | 'restituisci' | 'scarta'`
  - `export function classificaRichiamo(input: { date?: string; leadWords?: string; nowMs: number }): { fascia: FasciaRichiamo; quando: string | null }` — `quando` è la data formattata in ora di Roma, oppure le parole del lead sul periodo, oppure `null`.
  - `export function buildRichiamoRestituitoNote(input: { quando: string | null; leadWords?: string }): string`
  - `export function buildRichiamoScartatoReason(input: { quando: string | null }): string`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `lib/richiamo-fasce.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  RICHIAMO_FASCIA_APERTA_GG,
  RICHIAMO_FASCIA_RESTITUZIONE_GG,
  classificaRichiamo,
  buildRichiamoRestituitoNote,
  buildRichiamoScartatoReason,
} from './richiamo-fasce';

// Riferimento fisso: martedì 22 settembre 2026, 10:00 ora di Roma.
const NOW = Date.parse('2026-09-22T10:00:00+02:00');
const fra = (giorni: number, ora = '10:00') => {
  const d = new Date(NOW + giorni * 24 * 3600_000);
  const iso = d.toISOString().slice(0, 10);
  return `${iso}T${ora}:00+02:00`;
};

describe('le soglie', () => {
  it('sono 3 e 7 giorni', () => {
    expect(RICHIAMO_FASCIA_APERTA_GG).toBe(3);
    expect(RICHIAMO_FASCIA_RESTITUZIONE_GG).toBe(7);
  });
});

describe('classificaRichiamo, con una data', () => {
  it('domani: la chat resta aperta, la sequenza lo ripesca', () => {
    expect(classificaRichiamo({ date: fra(1), nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('esattamente a 3 giorni: ancora dentro la sequenza', () => {
    expect(classificaRichiamo({ date: fra(3), nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('a 4 giorni: fuori dalla sequenza, torna a un GDO', () => {
    expect(classificaRichiamo({ date: fra(4), nowMs: NOW }).fascia).toBe('restituisci');
  });

  it('esattamente a 7 giorni: ancora restituzione', () => {
    expect(classificaRichiamo({ date: fra(7), nowMs: NOW }).fascia).toBe('restituisci');
  });

  it('a 8 giorni: scarto, riscriverà lui', () => {
    expect(classificaRichiamo({ date: fra(8), nowMs: NOW }).fascia).toBe('scarta');
  });

  it('fra tre mesi: scarto', () => {
    expect(classificaRichiamo({ date: fra(90), nowMs: NOW }).fascia).toBe('scarta');
  });

  it('restituisce il "quando" leggibile in ora di Roma', () => {
    const r = classificaRichiamo({ date: fra(5, '15:00'), nowMs: NOW });
    expect(r.quando).toContain('27 settembre');
  });
});

describe('classificaRichiamo, senza una data usabile', () => {
  it('una data nel passato non è un esito: si tiene la chat aperta', () => {
    expect(classificaRichiamo({ date: fra(-2), nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('nessuna data e nessuna parola sul quando: si tiene la chat aperta', () => {
    expect(classificaRichiamo({ nowMs: NOW }).fascia).toBe('tieni_aperta');
    expect(classificaRichiamo({ leadWords: 'ok ci sentiamo', nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('"la settimana prossima" può stare dentro i 7 giorni: restituzione', () => {
    const r = classificaRichiamo({ leadWords: 'guarda risentiamoci la settimana prossima', nowMs: NOW });
    expect(r.fascia).toBe('restituisci');
    expect(r.quando).toBe('la settimana prossima');
  });

  it('"tra 5 giorni": restituzione', () => {
    expect(classificaRichiamo({ leadWords: 'tra 5 giorni', nowMs: NOW }).fascia).toBe('restituisci');
  });

  it('"tra 20 giorni": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'tra 20 giorni', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"a settembre": scarto, e riporta le parole del lead', () => {
    const r = classificaRichiamo({ leadWords: 'ci risentiamo a settembre allora', nowMs: NOW });
    expect(r.fascia).toBe('scarta');
    expect(r.quando).toBe('a settembre');
  });

  it('"dopo le ferie": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'dopo le ferie ne riparliamo', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"il mese prossimo": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'il mese prossimo', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"tra due settimane": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'tra due settimane', nowMs: NOW }).fascia).toBe('scarta');
  });
});

describe('i testi', () => {
  it('la nota di restituzione dice il giorno e cita il lead', () => {
    const n = buildRichiamoRestituitoNote({
      quando: 'sabato 26 settembre alle 15:00',
      leadWords: 'guarda richiamami sabato che oggi non riesco',
    });
    expect(n).toContain('sabato 26 settembre alle 15:00');
    expect(n).toContain('Parole del lead');
    // Non deve promettere niente a nome del GDO.
    expect(n).not.toMatch(/ti chiamiamo|lo richiamiamo noi/i);
  });

  it('la nota di restituzione regge anche senza un quando', () => {
    const n = buildRichiamoRestituitoNote({ quando: null, leadWords: 'richiamami più avanti' });
    expect(n).toContain('non ha detto quando');
  });

  it('il motivo di scarto dice che riscriverà lui', () => {
    expect(buildRichiamoScartatoReason({ quando: 'a settembre' }))
      .toBe('vuole essere risentito a settembre: gli è stato detto di riscrivere quando sarà il momento');
  });

  it('il motivo di scarto regge senza un quando', () => {
    expect(buildRichiamoScartatoReason({ quando: null }))
      .toBe('vuole essere risentito più avanti: gli è stato detto di riscrivere quando sarà il momento');
  });
});
```

- [ ] **Step 2: Lancia il test e verifica che fallisca**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test lib/richiamo-fasce.test.ts
```

Atteso: FAIL con `Cannot find module './richiamo-fasce'`.

- [ ] **Step 3: Scrivi il modulo**

Crea `lib/richiamo-fasce.ts`:

```ts
// Le tre fasce di un "risentiamoci più avanti", decise dal codice e non dal modello.
//
// Fino al 22/09/2026 un lead che chiedeva di essere risentito diventava un RICHIAMO:
// nel CRM una `recallDate` sul lead del bot. Il bot però non telefona, quindi quel
// richiamo non lo faceva nessuno e il lead restava parcheggiato per sempre — 93 lead
// fermi così al 22/09. E quando il lead passava a un umano (coda /richieste-contatto)
// il GDO se lo ritrovava in "Richiami" a un orario che nessuno aveva scelto: la data
// era calcolata dalla macchina e portava anche i secondi (25/09 alle 09:02:49).
//
// Decisione del PO (22/09/2026): il bot non scrive più richiami. Guarda QUANDO il lead
// vuole essere risentito e sceglie fra tre comportamenti.
//
// Il calcolo sta qui e non nel prompt di proposito: a un modello non si chiede di fare
// differenze fra date. Mario riconosce l'intenzione e riporta il "quando"; la fascia la
// decide questa funzione, che è pura e si testa.

import { estraiPeriodo } from './periodo-richiamo';
import { paroleDelLead } from './bot-outcome-rules';
import { formatRomeDateTime } from './rome-time';

/** Entro questi giorni non si chiude niente: la sequenza di follow-up (SEQUENCE_END_DAYS
 *  = 4) lo ripesca da sola, quindi il lead viene davvero riseguito. */
export const RICHIAMO_FASCIA_APERTA_GG = 3;

/** Fin qui il lead torna a un GDO umano, che il richiamo lo può fare davvero.
 *  Oltre, si scarta: tenerlo aperto significherebbe non toccarlo più. */
export const RICHIAMO_FASCIA_RESTITUZIONE_GG = 7;

export type FasciaRichiamo = 'tieni_aperta' | 'restituisci' | 'scarta';

const GIORNO_MS = 24 * 3600_000;

/** Un periodo a parole che può stare dentro i 7 giorni. Tutto il resto è più lontano.
 *  "tra N giorni" si guarda il numero; "settimana prossima" può essere 3 come 10 giorni
 *  e si sceglie la lettura che NON butta via il lead (la restituzione). */
const NUMERO_A_PAROLE: Record<string, number> = {
  un: 1, una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5,
  sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, quindici: 15, venti: 20,
};

function periodoEntroSetteGiorni(periodo: string): boolean {
  const t = periodo.toLowerCase();
  const giorni = t.match(/\b(?:tra|fra)\s+([a-zà-ù]+|\d{1,3})\s+giorn[oi]\b/);
  if (giorni) {
    const grezzo = giorni[1];
    const n = /^\d+$/.test(grezzo) ? Number(grezzo) : NUMERO_A_PAROLE[grezzo];
    return typeof n === 'number' && n <= RICHIAMO_FASCIA_RESTITUZIONE_GG;
  }
  // "la settimana prossima" / "settimana prossima": l'unica espressione vaga che può
  // cadere dentro la settimana. "mese", "anno" e le stagioni no.
  if (/\b(?:l[ao]\s+)?(?:prossima\s+settimana|settimana\s+prossima)\b/.test(t)) return true;
  return false;
}

/**
 * In quale fascia cade questo "risentiamoci"?
 *
 * `quando` è la cosa da mostrare a un umano: la data formattata in ora di Roma se il
 * lead l'ha detta, altrimenti le sue parole sul periodo, altrimenti `null`.
 *
 * Una data assente, illeggibile o nel passato NON è un esito: torna `tieni_aperta`, e
 * il chiamante manda al CRM la nota "giorno e ora da concordare" che già esiste. Non si
 * deduce mai una data da niente: è esattamente il bug chiuso il 06/08.
 */
export function classificaRichiamo(input: {
  date?: string;
  leadWords?: string;
  nowMs: number;
}): { fascia: FasciaRichiamo; quando: string | null } {
  const t = input.date ? Date.parse(input.date) : NaN;
  if (!Number.isNaN(t) && t >= input.nowMs) {
    const giorni = (t - input.nowMs) / GIORNO_MS;
    const quando = formatRomeDateTime(input.date!);
    if (giorni <= RICHIAMO_FASCIA_APERTA_GG) return { fascia: 'tieni_aperta', quando };
    if (giorni <= RICHIAMO_FASCIA_RESTITUZIONE_GG) return { fascia: 'restituisci', quando };
    return { fascia: 'scarta', quando };
  }

  const periodo = estraiPeriodo(input.leadWords);
  if (!periodo) return { fascia: 'tieni_aperta', quando: null };
  return {
    fascia: periodoEntroSetteGiorni(periodo) ? 'restituisci' : 'scarta',
    quando: periodo,
  };
}

/** La nota che accompagna la restituzione al GDO. Dice il fatto e il giorno, e non
 *  prende impegni a nome di nessuno: chi la legge decide se e quando telefonare. */
export function buildRichiamoRestituitoNote(input: {
  quando: string | null;
  leadWords?: string;
}): string {
  const parole = paroleDelLead(input.leadWords);
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  const quando = input.quando
    ? `Voleva essere risentito ${input.quando}.`
    : 'Voleva essere risentito più avanti ma non ha detto quando.';
  return (
    `VOLEVA ESSERE RISENTITO — il bot ha smesso di lavorarlo e te lo ridà. ${quando}` +
    citazione
  );
}

/** Il motivo che viaggia con il `DA_SCARTARE` della terza fascia. */
export function buildRichiamoScartatoReason(input: { quando: string | null }): string {
  const quando = input.quando ? `risentito ${input.quando}` : 'risentito più avanti';
  return `vuole essere ${quando}: gli è stato detto di riscrivere quando sarà il momento`;
}
```

- [ ] **Step 4: Lancia il test e verifica che passi**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test lib/richiamo-fasce.test.ts
```

Atteso: PASS, tutti i casi. Se `formatRomeDateTime` produce un formato diverso da "sabato 26 settembre alle 15:00", **non cambiare il test a caso**: apri `lib/rome-time.ts`, leggi il formato vero e allinea l'asserzione `toContain('27 settembre')` a quello.

- [ ] **Step 5: Typecheck e commit**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun run typecheck && bun run lint
git add lib/richiamo-fasce.ts lib/richiamo-fasce.test.ts
git commit -m "feat(richiami): le tre fasce di un 'risentiamoci piu' avanti', decise dal codice

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `sendOutcome` smette di mandare richiami al CRM

**Files:**
- Modify: `lib/bot-outcome.ts` (dentro `sendOutcome`, fra la guardia `holdsAppointment` e `const dataCheck`, intorno a riga 688)
- Test: `lib/bot-outcome.test.ts` (esiste già — aggiungere un `describe` in coda)

**Interfaces:**
- Consumes: `classificaRichiamo`, `buildRichiamoRestituitoNote`, `buildRichiamoScartatoReason` dalla Task 5.
- Produces: nessuna nuova firma pubblica. `sendOutcome` continua a ritornare la stessa forma; per la fascia `tieni_aperta` ritorna `keepOpen: true` come già fa il ramo "richiamo senza data".

**Contesto che serve all'implementatore.** In `sendOutcome`:
- `interim` è `true` solo per il ping automatico della sequenza (Task 7 lo elimina, ma la variabile resta per compatibilità).
- `holdsAppointment` è `true` quando la conversazione tiene già un appuntamento: in quel caso `RICHIAMO` significa "il lead vuole spostare" e **deve continuare** per la sua strada verso `resolveOutcomeAction`, che lo traduce in NOTA. **Non toccare quel percorso.**
- Il nuovo blocco va **prima** di `const dataCheck = ...` e **dopo** `if (holdsAppointment && !interim && isRichiestaDisdetta(...))`.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in coda a `lib/bot-outcome.test.ts`:

```ts
describe('RICHIAMO su trattativa aperta: le tre fasce (dal 22/09/2026)', () => {
  it('entro 3 giorni non manda niente al CRM e tiene la chat aperta', async () => {
    const { supabase, chiamate } = fakeSupabase({ crm_lead_id: 'lead-1', bot_outcome: null });
    const r = await sendOutcome(supabase, 1, {
      outcome: 'RICHIAMO',
      date: isoFraGiorni(2),
      leadWords: 'richiamami dopodomani',
    });
    expect(r.keepOpen).toBe(true);
    expect(chiamate.postAlCrm).toHaveLength(0);
  });

  it('fra 4 e 7 giorni manda PRIMA una nota e POI la restituzione, mai un RICHIAMO', async () => {
    const { supabase, chiamate } = fakeSupabase({ crm_lead_id: 'lead-2', bot_outcome: null });
    await sendOutcome(supabase, 2, {
      outcome: 'RICHIAMO',
      date: isoFraGiorni(5),
      leadWords: 'richiamami sabato',
    });
    expect(chiamate.postAlCrm.map((c) => c.outcome)).toEqual(['NOTA', 'INTERROTTO']);
    expect(chiamate.postAlCrm[0].note).toContain('VOLEVA ESSERE RISENTITO');
    expect(chiamate.postAlCrm.some((c) => c.outcome === 'RICHIAMO')).toBe(false);
  });

  it('oltre 7 giorni manda DA_SCARTARE con il motivo giusto', async () => {
    const { supabase, chiamate } = fakeSupabase({ crm_lead_id: 'lead-3', bot_outcome: null });
    await sendOutcome(supabase, 3, {
      outcome: 'RICHIAMO',
      date: isoFraGiorni(40),
      leadWords: 'ci risentiamo a novembre',
    });
    expect(chiamate.postAlCrm).toHaveLength(1);
    expect(chiamate.postAlCrm[0].outcome).toBe('DA_SCARTARE');
    expect(chiamate.postAlCrm[0].discardReason).toContain('riscrivere quando sarà il momento');
  });

  it('su un appuntamento GIÀ fissato il RICHIAMO resta uno spostamento: nessuna fascia', async () => {
    const { supabase, chiamate } = fakeSupabase({
      crm_lead_id: 'lead-4',
      bot_outcome: 'APPUNTAMENTO',
      bot_scheduled_at: isoFraGiorni(1),
    });
    await sendOutcome(supabase, 4, {
      outcome: 'RICHIAMO',
      date: isoFraGiorni(30),
      leadWords: 'spostiamo',
    });
    // resolveOutcomeAction lo traduce in NOTA: l'appuntamento non si declassa mai.
    expect(chiamate.postAlCrm.map((c) => c.outcome)).toEqual(['NOTA']);
  });
});
```

**Nota per l'implementatore:** `fakeSupabase` e `isoFraGiorni` potrebbero non esistere con questi nomi in `lib/bot-outcome.test.ts`. **Leggi il file prima**: riusa gli helper che ci sono già (il file testa `sendOutcome` da tempo e ha un doppio di Supabase). Se gli helper esistenti hanno altri nomi, adatta il test a quelli invece di aggiungerne di nuovi. Se in quel file non si intercettano i POST al CRM, intercetta `fetch` come fa il resto del file.

- [ ] **Step 2: Lancia il test e verifica che fallisca**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test lib/bot-outcome.test.ts
```

Atteso: FAIL — oggi parte un `RICHIAMO` in tutti e tre i primi casi.

- [ ] **Step 3: Implementa**

In `lib/bot-outcome.ts`, aggiungi l'import in cima:

```ts
import {
  classificaRichiamo,
  buildRichiamoRestituitoNote,
  buildRichiamoScartatoReason,
} from './richiamo-fasce';
```

e inserisci questo blocco **subito dopo** la guardia `if (holdsAppointment && !interim && isRichiestaDisdetta(args.outcome)) { await marcaDisdetta(...) }` e **prima** di `const dataCheck = ...`:

```ts
  // LE TRE FASCE DI UN "RISENTIAMOCI PIÙ AVANTI" (PO, 22/09/2026).
  //
  // Il bot non manda più `RICHIAMO` al CRM su una trattativa aperta: quell'esito
  // scriveva una `recallDate` sul lead del bot, che non telefona — quindi il richiamo
  // non lo faceva nessuno e il lead restava fermo (93 lead così al 22/09). E quando poi
  // il lead passava a un umano, il GDO se lo ritrovava in "Richiami" a un'ora scelta
  // dalla macchina, per una persona che non aveva mai sentito.
  //
  // `holdsAppointment` esclude il caso "vuole spostare l'appuntamento già fissato": lì
  // RICHIAMO ha un altro significato e la sua strada (→ NOTA via resolveOutcomeAction)
  // resta quella di prima. `interim` è il ping della sequenza, che non passa più di qui.
  if (args.outcome === 'RICHIAMO' && !interim && !holdsAppointment) {
    const { fascia, quando } = classificaRichiamo({
      date: args.date,
      leadWords: args.leadWords ?? args.note,
      nowMs: Date.now(),
    });

    if (fascia === 'tieni_aperta') {
      // Non è un esito: la sequenza di follow-up lo ripesca da sola entro 4 giorni.
      // Nessun POST — al CRM non serve sapere che una chat è ancora viva.
      await supabase.from('event_log').insert({
        type: 'richiamo_tenuto_aperto',
        payload: { conversationId, crmLeadId, date: args.date ?? null, quando } as never,
        message: `[bot-fissatore] richiamo entro ${3} giorni per lead ${crmLeadId}: chat tenuta aperta, nessun esito`,
        level: 'info',
      });
      return { sent: false, error: 'richiamo_entro_finestra', keepOpen: true };
    }

    if (fascia === 'restituisci') {
      // Prima la nota (così il GDO che lo riceve legge il "quando" che il lead ha
      // detto), poi la restituzione vera. Stesso ordine del ramo
      // `conferma_senza_appuntamento` in bot-followups: l'esito chiude la chat, la
      // segnalazione deve precederlo.
      const nota = buildRichiamoRestituitoNote({ quando, leadWords: args.leadWords ?? args.note });
      await inviaNotaAlCrm(supabase, conversationId, crmLeadId, nota, args.report, secret);
      await supabase.from('event_log').insert({
        type: 'richiamo_restituito',
        payload: { conversationId, crmLeadId, quando } as never,
        message: `[bot-fissatore] richiamo oltre 3 giorni per lead ${crmLeadId}: lead restituito a un GDO con nota`,
        level: 'info',
      });
      return sendOutcome(supabase, conversationId, {
        ...args,
        outcome: 'INTERROTTO',
        date: undefined,
        note: nota,
      });
    }

    // fascia === 'scarta'
    await supabase.from('event_log').insert({
      type: 'richiamo_scartato',
      payload: { conversationId, crmLeadId, quando } as never,
      message: `[bot-fissatore] richiamo oltre 7 giorni per lead ${crmLeadId}: scartato, riscriverà lui`,
      level: 'info',
    });
    return sendOutcome(supabase, conversationId, {
      ...args,
      outcome: 'DA_SCARTARE',
      date: undefined,
      discardReason: buildRichiamoScartatoReason({ quando }),
    });
  }
```

**Attenzione alla ricorsione:** le due chiamate ricorsive cambiano `outcome`, quindi la condizione `args.outcome === 'RICHIAMO'` è falsa al secondo giro e non si rientra. Non aggiungere flag: la terminazione è nel cambio di `outcome`.

- [ ] **Step 4: Lancia i test e verifica che passino**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test lib/bot-outcome.test.ts && bun test
```

Atteso: PASS. Se qualche test preesistente su `RICHIAMO` fallisce, **leggilo**: se testava il vecchio comportamento su trattativa aperta va riscritto sulla nuova regola; se testava lo spostamento di un appuntamento già fissato, è una regressione vera e il blocco è nel posto sbagliato.

- [ ] **Step 5: Commit**

```bash
git add lib/bot-outcome.ts lib/bot-outcome.test.ts
git commit -m "fix(richiami): il bot non manda piu' RICHIAMO al CRM su una trattativa aperta

Tiene la chat entro 3 giorni, restituisce con una nota fino a 7, scarta oltre.
Lo spostamento di un appuntamento gia' fissato resta una NOTA, com'era.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Il ping della sequenza diventa una nota

**Files:**
- Modify: `app/api/cron/sequence-touches/route.ts:325-341`

**Interfaces:**
- Consumes: `sendOutcome` (già importato in quel file).
- Produces: niente.

**Perché.** Oggi, dopo il primo follow-up, quel blocco manda `RICHIAMO` con `date = primo messaggio + 4 giorni` solo per far vedere al CRM "lavorazione estesa in corso". È la sorgente numero uno dei richiami con l'ora della macchina: la data porta minuti e secondi del primo invio (Tania Maia, richiamo il 25/09 alle **09:02:49**). 396 lead ce l'hanno addosso. La stessa informazione, come `NOTA`, non scrive nessuna `recallDate`.

- [ ] **Step 1: Sostituisci il blocco**

Sostituisci le righe da `// Dopo il primo follow-up riuscito: RICHIAMO interim` fino alla chiusura del blocco `if (touchRes.ok && action.touchIndex === 1) { ... }` con:

```ts
          // Dopo il primo follow-up riuscito: una NOTA al CRM (una volta sola, perché
          // il touch 1 parte una volta sola) che dice fino a quando la sequenza va
          // avanti. Fino al 22/09/2026 era un RICHIAMO con `date = t0 + 4 giorni`: una
          // `recallDate` con i secondi della macchina addosso, che finiva nei "Richiami"
          // di un GDO appena il lead passava a un umano. Serve visibilità, non un
          // appuntamento telefonico: la nota la dà senza toccare lo stato del lead.
          if (touchRes.ok && action.touchIndex === 1) {
            const t0 = firstOutboundAtMs(msgs);
            if (t0 !== null) {
              const fine = toRomeIso(t0 + SEQUENCE_END_DAYS * 24 * H);
              await sendOutcome(supabase, c.id, {
                outcome: 'NOTA',
                note:
                  'Sequenza WhatsApp estesa in corso: tentativi automatici fino al ' +
                  `${formatRomeDateTime(fine)}, poi esito definitivo. Non è un richiamo: ` +
                  'non c\'è niente da chiamare a quell\'ora.',
              });
            }
          }
```

Aggiungi l'import di `formatRomeDateTime` da `@/lib/rome-time` in cima al file se non c'è già. Se `toRomeIso` diventa inutilizzato altrove nel file, **lascialo**: serve ancora al resto del cron.

- [ ] **Step 2: Verifica che nessun test dipendesse dall'interim**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && grep -rn "interim" --include=*.test.ts lib app
```

Se esistono test su `opts.interim`, **non cancellarli**: `sendOutcome` accetta ancora `interim` (nessun chiamante lo usa più, ma l'opzione resta parte dell'API). Se un test asseriva che il cron manda un `RICHIAMO`, aggiornalo a `NOTA`.

- [ ] **Step 3: Test e typecheck**

```bash
bun test && bun run typecheck && bun run lint
```

Atteso: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/sequence-touches/route.ts
git commit -m "fix(sequenza): il ping 'lavorazione estesa' e' una nota, non un richiamo

Era la sorgente principale dei richiami con l'ora della macchina (09:02:49).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Le parole di Mario per la terza fascia

**Files:**
- Modify: `lib/mario-prompt.ts:347` (la riga "Vuole essere richiamato") e `lib/mario-prompt.ts:351` (il blocco "MAI INVENTARE UNA DATA")

**Interfaces:** nessuna firma cambia.

**Cosa NON toccare:** la riga 353 (l'ECCEZIONE sull'appuntamento già fissato) e la riga 298 (la sezione "SE L'APPUNTAMENTO È GIÀ FISSATO"). Lì `RICHIAMO` significa "vuole spostare" ed è il comportamento giusto.

⚠️ **Questa task cambia cosa arriva al lead.** Per `project_bot_regole_intoccabili` va concordata con Bruno prima del deploy: il testo esatto qui sotto va mostrato e approvato.

- [ ] **Step 1: Sostituisci la riga 347**

Da:

```
- Vuole essere richiamato: [ESITO:RICHIAMO|<la data ISO 8601 con fuso SOLO se te l'ha detta lui, altrimenti le sue parole testuali sul quando, es. "a settembre">]
```

a:

```
- Vuole essere risentito più avanti: [ESITO:RICHIAMO|<la data ISO 8601 con fuso SOLO se te l'ha detta lui, altrimenti le sue parole testuali sul quando, es. "a settembre">]. Non prometti nessun richiamo: questo tag dice solo QUANDO lui vorrebbe, e a cosa farne ci pensa il sistema. Se il "quando" che ti ha detto è fra più di una settimana, prima di chiudere digli con garbo che non gli scriverai più e che quando sarà il momento può scrivere lui qui, che lo riprendi al volo — es. "va benissimo, allora non ti sto dietro: quando ti torna comodo scrivimi tu qui e ripartiamo da dove siamo rimasti". Se invece è entro pochi giorni non dirgli niente del genere: ti fai vivo tu.
```

- [ ] **Step 2: Aggiungi una riga al blocco "MAI INVENTARE UNA DATA"**

Subito dopo la riga 351, aggiungi:

```
E NON PROMETTERE MAI UNA TELEFONATA né un tuo messaggio a una data precisa quando usi questo tag: tu non chiami nessuno (vedi la regola sopra), e chi lo richiamerà — se lo richiamerà — è una persona che decide da sé quando. Il massimo che puoi dire è che ti fai sentire qui su WhatsApp, e solo se il suo "quando" è entro pochi giorni.
```

- [ ] **Step 3: Verifica che i test del prompt passino**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test && bun run typecheck
```

Atteso: PASS. Alcuni test fanno asserzioni sul contenuto del prompt (lunghezza, presenza di frasi): se falliscono, leggili e aggiorna l'asserzione, non il prompt.

- [ ] **Step 4: Commit**

```bash
git add lib/mario-prompt.ts
git commit -m "feat(prompt): oltre una settimana Mario congeda il lead invece di promettere un richiamo

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Il CRM non scrive più un richiamo per conto del bot

**Files:**
- Create: `src/lib/bot-fissatore/richiamoGuard.ts`
- Test: `src/lib/bot-fissatore/richiamoGuard.test.ts`
- Modify: `src/app/api/bot/outcome/route.ts`
- Modify: `package.json` (lista dei test)

**Interfaces:**
- Produces: `export function richiamoDalBotDiventaNota(outcome: string): boolean`, `export function buildRichiamoDegradatoNote(input: { date?: string; periodo?: string; note?: string }): string`

**Perché una guardia lato CRM se il bot non manda più richiami.** Perché è l'unico punto che non si può aggirare. Il bot è un altro repo con un altro deploy: un rollback, un branch vecchio o un ritentativo dalla coda `arretrati` rimetterebbero in circolo i richiami senza che nessuno se ne accorga. Qui costa dieci righe ed è definitivo. Il contratto non si rompe: `RICHIAMO` resta accettato e continua a rispondere `200`.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `src/lib/bot-fissatore/richiamoGuard.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { richiamoDalBotDiventaNota, buildRichiamoDegradatoNote } from './richiamoGuard';

test('solo RICHIAMO viene degradato a nota', () => {
    assert.equal(richiamoDalBotDiventaNota('RICHIAMO'), true);
    for (const o of ['APPUNTAMENTO', 'DA_SCARTARE', 'NON_RISPOSTO', 'INTERROTTO', 'NOTA', 'CONTATTO_UMANO']) {
        assert.equal(richiamoDalBotDiventaNota(o), false, `${o} non deve essere degradato`);
    }
});

test('la nota dice il quando quando il bot lo manda come data', () => {
    const n = buildRichiamoDegradatoNote({ date: '2026-10-05T15:00:00+02:00' });
    assert.ok(n.includes('VOLEVA ESSERE RISENTITO'));
    assert.ok(n.includes('05/10/2026'));
    assert.ok(!n.toLowerCase().includes('richiamo fissato'));
});

test('la nota dice il quando quando il bot lo manda come periodo', () => {
    const n = buildRichiamoDegradatoNote({ periodo: 'a settembre' });
    assert.ok(n.includes('a settembre'));
});

test('la nota regge senza data e senza periodo', () => {
    const n = buildRichiamoDegradatoNote({});
    assert.ok(n.includes('non ha detto quando'));
});

test('la nota porta la nota originale del bot quando c\'è', () => {
    const n = buildRichiamoDegradatoNote({ periodo: 'a ottobre', note: 'sta cambiando lavoro' });
    assert.ok(n.includes('sta cambiando lavoro'));
});
```

- [ ] **Step 2: Lancia il test e verifica che fallisca**

```bash
cd "C:/Users/bruno/Desktop/CRM GDO" && node --import tsx --test src/lib/bot-fissatore/richiamoGuard.test.ts
```

Atteso: FAIL, modulo inesistente.

- [ ] **Step 3: Scrivi il modulo**

Crea `src/lib/bot-fissatore/richiamoGuard.ts`:

```ts
/**
 * Un `RICHIAMO` che arriva dal bot non diventa mai un richiamo.
 *
 * Il bot non telefona: una `recallDate` scritta da lui è una riga che nessuno onora.
 * Finché il lead resta sull'account bot marcisce lì (93 lead fermi così al 22/09/2026);
 * appena passa a un umano — la coda /richieste-contatto lo fa di continuo — il GDO se lo
 * ritrova nei "Richiami" a un'ora scelta dalla macchina, per una persona mai sentita.
 *
 * Dal 22/09/2026 il bot non manda più `RICHIAMO` su una trattativa aperta (vedi
 * `lib/richiamo-fasce.ts` nel repo del bot). Questa guardia è la rete: il bot è un altro
 * repo con un altro deploy, e un rollback rimetterebbe in circolo i richiami senza che
 * nessuno se ne accorga.
 *
 * Il contratto non si rompe (`docs/bot-fissatore-contract.md`, "il contratto cresce, non
 * cambia"): `RICHIAMO` resta un esito valido e la risposta resta `200`. Cambia solo cosa
 * ne facciamo — una nota in timeline invece di una data in pipeline.
 */
export function richiamoDalBotDiventaNota(outcome: string): boolean {
    return outcome === 'RICHIAMO';
}

function formattaData(iso: string): string | null {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Intl.DateTimeFormat('it-IT', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
    }).format(new Date(t));
}

export function buildRichiamoDegradatoNote(input: {
    date?: string;
    periodo?: string;
    note?: string;
}): string {
    const quando = input.date ? formattaData(input.date) : null;
    const testa = quando
        ? `Voleva essere risentito il ${quando}.`
        : input.periodo?.trim()
            ? `Voleva essere risentito ${input.periodo.trim()}.`
            : 'Voleva essere risentito più avanti ma non ha detto quando.';
    const coda = input.note?.trim() ? ` ${input.note.trim()}` : '';
    return (
        `VOLEVA ESSERE RISENTITO — il bot ha registrato questa richiesta. ${testa}` +
        ' Non è un richiamo in pipeline: decidi tu se e quando chiamarlo.' + coda
    );
}
```

- [ ] **Step 4: Lancia il test e verifica che passi**

```bash
cd "C:/Users/bruno/Desktop/CRM GDO" && node --import tsx --test src/lib/bot-fissatore/richiamoGuard.test.ts
```

Atteso: PASS. Se il formato di `05/10/2026` non combacia, allinea l'asserzione al formato che `Intl` produce davvero su questa macchina.

- [ ] **Step 5: Aggancia la guardia alla route**

In `src/app/api/bot/outcome/route.ts`:

1. Aggiungi l'import: `import { richiamoDalBotDiventaNota, buildRichiamoDegradatoNote } from '@/lib/bot-fissatore/richiamoGuard';`
2. **Subito prima** del blocco `if (typedOutcome === 'NOTA') {` (riga ~373), inserisci:

```ts
    // Un RICHIAMO dal bot non scrive mai una recallDate: diventa una nota in timeline.
    // Vedi `richiamoGuard.ts` per il perché. Si riscrive `typedOutcome` e si lascia
    // proseguire nel ramo NOTA, così la nota passa dalla stessa deduplica e dalle stesse
    // notifiche di tutte le altre — nessun percorso parallelo da tenere allineato.
    if (richiamoDalBotDiventaNota(typedOutcome)) {
        console.warn(`[bot-fissatore] RICHIAMO degradato a nota su lead ${leadId}`);
        note = buildRichiamoDegradatoNote({ date, periodo: recallPeriod ?? undefined, note });
        typedOutcome = 'NOTA';
        date = undefined;
    }
```

3. Perché l'assegnazione funzioni, `typedOutcome`, `note` e `date` devono essere dichiarate con `let` e non `const`. **Leggi le dichiarazioni** (righe ~66-96) e cambiale solo se sono `const`. Se `typedOutcome` è tipizzato stretto sull'unione degli esiti, l'assegnazione a `'NOTA'` compila senza cast.

4. La validazione di riga 80 (`per RICHIAMO serve date oppure periodo`) **resta dov'è**: sta prima e continua a valere, così un RICHIAMO malformato prende ancora 400 e il bot se ne accorge.

- [ ] **Step 6: Aggiungi il test alla lista di `npm test`**

In `package.json`, dentro lo script `test`, aggiungi `src/lib/bot-fissatore/richiamoGuard.test.ts` subito dopo `src/lib/bot-fissatore/noteDedup.test.ts`.

- [ ] **Step 7: Lancia tutta la suite**

```bash
cd "C:/Users/bruno/Desktop/CRM GDO" && npm test && npx tsc --noEmit && npm run lint
```

Atteso: PASS, suite intera.

- [ ] **Step 8: Commit**

```bash
git add src/lib/bot-fissatore/richiamoGuard.ts src/lib/bot-fissatore/richiamoGuard.test.ts src/app/api/bot/outcome/route.ts package.json
git commit -m "fix(bot): un RICHIAMO dal bot diventa una nota, mai una recallDate

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Chi consegna un lead a un umano azzera il richiamo

**Files:**
- Modify: `src/app/actions/contactRequestActions.ts:249-259`
- Modify: `src/lib/bot-fissatore/reassign.ts:60-76`

**Interfaces:** nessuna firma cambia.

**Perché.** Sono le due strade per cui i richiami del bot arrivavano davvero in mano a un GDO. `reassignBotLeadToHumanPool` già azzera `recallDate`/`recallNote`/`recallMissedAt` nel ramo normale (`resetFields`, riga 110) — ma non nel ramo `batch_senso_unico`, che marca REJECTED e basta. E `assignContactRequest` non li azzera affatto: è così che Tania Maia è arrivata a GDO 119 il 22/09 con un richiamo al **25/09 alle 09:02:49**.

- [ ] **Step 1: `assignContactRequest`**

Nel `.set({ ... })` dell'update su `leads` (riga ~251), aggiungi tre campi:

```ts
            .set({
                assignedToId: gdoId,
                assignedAt: now,
                updatedAt: now,
                // Il lead cambia mano: il richiamo che aveva addosso era del bot, e il
                // bot non telefona. Lasciarlo significa mettere nei "Richiami" del GDO
                // una persona che non ha mai sentito, a un'ora che nessuno ha scelto
                // (Tania Maia, 22/09/2026: richiamo al 25/09 alle 09:02:49).
                recallDate: null,
                recallNote: null,
                recallMissedAt: null,
                // Un lead scartato che chiede di essere richiamato torna in pipeline.
                ...(row.leadStatus === 'REJECTED' ? { status: 'NEW', discardReason: null } : {}),
            })
```

- [ ] **Step 2: il ramo `batch_senso_unico`**

In `src/lib/bot-fissatore/reassign.ts`, nel `.set({ status: 'REJECTED', assignedToId: null, updatedAt: new Date() })` (riga ~61), aggiungi gli stessi tre campi:

```ts
                .set({
                    status: 'REJECTED',
                    assignedToId: null,
                    // Come in `resetFields`: un lead che esce dal bot non porta con sé
                    // il richiamo del bot. Senza questo, un lead di questo ramo ripescato
                    // dalla coda /richieste-contatto arriva al GDO con la data addosso
                    // (Adelmo Anselmo, 22/09/2026).
                    recallDate: null,
                    recallNote: null,
                    recallMissedAt: null,
                    updatedAt: new Date(),
                })
```

- [ ] **Step 3: Verifica**

```bash
cd "C:/Users/bruno/Desktop/CRM GDO" && npm test && npx tsc --noEmit && npm run lint
```

Atteso: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/actions/contactRequestActions.ts src/lib/bot-fissatore/reassign.ts
git commit -m "fix(richiami): un lead che passa a un umano non porta con se' il richiamo del bot

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

# PARTE 3 — Bonifica e deploy (Task 11-12)

### Task 11: Bonifica dei lead fermi sul bot

**Files:**
- Create: `scripts/bonifica-lead-fermi-bot.ts` (repo CRM)

**Interfaces:** script autonomo, si lancia a mano.

**Cosa deve fare, per gruppi.** Tutti i gruppi agiscono **solo** su lead `companyId = 'fenice'`, assegnati all'account bot, in stato `NEW` o `IN_PROGRESS`. Un lead in `APPOINTMENT` o con `presentedAt` valorizzato **non si tocca mai**: è la stessa invariante di `isLeadLocked`.

| Gruppo | Selezione | Azione |
|---|---|---|
| **A — flood lista 133** | `intakeBatch = 'DB_LISTA133_20260915'` | `status='REJECTED'`, `assignedToId=null`, `discardReason='lista 133: infornata a senso unico, mai lavorata'`. `intakeBatch` **resta** (è la maniglia per ripescarli). ~361 lead. |
| **B — richiami morti** | `intakeBatch IS NULL`, `assignedAt < now()-7d`, `recallDate IS NOT NULL` | `status='REJECTED'`, `assignedToId=null`, `recallDate/recallNote/recallMissedAt = null`, `discardReason='voleva essere risentito piu'' avanti: il bot non telefona, richiamo mai fatto'`. ~93 lead. |
| **C — gemelli** | `intakeBatch IS NULL`, `assignedAt < now()-7d`, esiste un altro lead Fenice con lo stesso `phone` | `status='REJECTED'`, `assignedToId=null`, `discardReason='duplicato per telefono: lavorato sotto un altro lead'`. ~152 lead. |
| **D — telefoni non chiamabili** | `intakeBatch IS NULL`, `assignedAt < now()-7d`, telefono non è un mobile italiano a 10 cifre | `status='REJECTED'`, `assignedToId=null`, `discardReason='telefono non valido'`. ~26 lead. |
| **E — richiami ereditati dai vivi** | lead assegnati a un **umano**, `recallNote ILIKE '%Sequenza WhatsApp estesa%'` | solo `recallDate/recallNote/recallMissedAt = null`. **Nessun cambio di stato né di assegnatario**: sono lead vivi di un GDO, si toglie solo il richiamo fasullo. ~6 lead. |

**Ordine obbligatorio:** A → B → C → D → E. B prima di C perché un lead con un richiamo morto merita quel motivo, non "duplicato".

**Le selezioni, esatte.** Lo script esegue queste `SELECT` in dry-run e le stesse `WHERE` nelle `UPDATE` quando gira con `--esegui`. `:bot` è l'id dell'account bot (`select id from users where "isBot" and "companyId"='fenice'`).

```sql
-- guardia comune a tutti i gruppi salvo E
-- (l'invariante di isLeadLocked: non si tocca chi ha prodotto storico)
--   l."companyId"='fenice' AND l."assignedToId"=:bot
--   AND l.status IN ('NEW','IN_PROGRESS') AND l."presentedAt" IS NULL

-- A — flood lista 133
... AND l."intakeBatch" = 'DB_LISTA133_20260915'

-- B — richiami morti  (dopo A: A ha già tolto i lead del flood)
... AND l."intakeBatch" IS NULL
    AND l."assignedAt" < now() - interval '7 days'
    AND l."recallDate" IS NOT NULL

-- C — gemelli  (dopo B)
... AND l."intakeBatch" IS NULL
    AND l."assignedAt" < now() - interval '7 days'
    AND EXISTS (SELECT 1 FROM leads o
                WHERE o.phone = l.phone AND o.id <> l.id AND o."companyId" = 'fenice')

-- D — telefoni non chiamabili  (dopo C)
... AND l."intakeBatch" IS NULL
    AND l."assignedAt" < now() - interval '7 days'
    AND regexp_replace(coalesce(l.phone,''), '[^0-9]', '', 'g') !~ '^(39)?3[0-9]{9}$'

-- E — richiami ereditati dai vivi  (NON usa la guardia comune)
SELECT l.id FROM leads l JOIN users u ON u.id = l."assignedToId"
WHERE l."companyId"='fenice' AND u."isBot" = false
  AND l."recallNote" ILIKE '%Sequenza WhatsApp estesa%'
  AND l."recallDate" IS NOT NULL
```

Le `UPDATE` per gruppo:

```sql
-- A, B, C, D  (discardReason cambia per gruppo, vedi la tabella sopra)
UPDATE leads SET status='REJECTED', "assignedToId"=NULL,
  "discardReason"=:motivo, "recallDate"=NULL, "recallNote"=NULL, "recallMissedAt"=NULL,
  "updatedAt"=now(), version = version + 1
WHERE id = :leadId;

-- E  (solo il richiamo: il lead resta vivo e resta del suo GDO)
UPDATE leads SET "recallDate"=NULL, "recallNote"=NULL, "recallMissedAt"=NULL,
  "updatedAt"=now(), version = version + 1
WHERE id = :leadId;
```

- [ ] **Step 1: Scrivi lo script**

Crea `scripts/bonifica-lead-fermi-bot.ts` modellato su `scripts/import-cdr.ts` (stesso stile di connessione via Drizzle e `--env-file=.env`), usando le query qui sopra. Requisiti non negoziabili:

1. **Dry-run di default.** Senza `--esegui` non scrive niente e stampa il conteggio per gruppo più 5 righe d'esempio ciascuno.
2. **Ogni gruppo in una transazione sua**, così un errore su C non annulla A e B.
3. **Un `leadEvents` per ogni lead toccato**, `eventType: 'BONIFICA_LEAD_FERMO'`, `userId: null`, `metadata: { gruppo, discardReason, precedente: { status, assignedToId, recallDate } }`. Senza questo la bonifica è irreversibile e muta.
4. **Nessuna riga cancellata.** Mai un `DELETE`.
5. La guardia di sicurezza in ogni `WHERE`: `status IN ('NEW','IN_PROGRESS') AND "presentedAt" IS NULL` (tranne il gruppo E, che non cambia stato).
6. Stampa a fine corsa il totale per gruppo e il totale generale.

- [ ] **Step 2: Lancia il dry-run**

```bash
cd "C:/Users/bruno/Desktop/CRM GDO" && node --import tsx --env-file=.env scripts/bonifica-lead-fermi-bot.ts
```

Atteso, come ordine di grandezza (22/09/2026): A ≈ 361, B ≈ 93, C ≈ 152, D ≈ 26, E ≈ 6. **Se un gruppo si discosta di oltre il 30% da questi numeri, fermati e chiedi**: la selezione sta prendendo lead che non deve.

- [ ] **Step 3: Mostra il dry-run a Bruno e fermati**

Non eseguire senza il suo ok esplicito su questa corsa: è una scrittura di massa su produzione.

- [ ] **Step 4: Esegui**

```bash
node --import tsx --env-file=.env scripts/bonifica-lead-fermi-bot.ts --esegui
```

- [ ] **Step 5: Verifica dopo la corsa**

```sql
-- nessun lead umano con un richiamo della macchina
select count(*) from leads l join users u on u.id=l."assignedToId" and u."isBot"=false
where l."recallDate" is not null and extract(second from l."recallDate") <> 0;
-- atteso: 0

-- nessun lead fermo sul bot oltre 7 giorni
select count(*) from leads l join users u on u.id=l."assignedToId" and u."isBot"=true
where l.status in ('NEW','IN_PROGRESS') and l."assignedAt" < now() - interval '7 days';
-- atteso: vicino a 0 (restano solo le chat davvero aperte)
```

- [ ] **Step 6: Commit**

```bash
git add scripts/bonifica-lead-fermi-bot.ts
git commit -m "chore(bonifica): chiude i lead fermi sul bot (flood, richiami morti, gemelli, telefoni rotti)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Deploy e verifica in produzione

- [ ] **Step 1: Suite intera sui due repo**

```bash
cd "C:/Users/bruno/Desktop/Software Messaggistica" && bun test && bun run typecheck && bun run lint && bun run build
cd "C:/Users/bruno/Desktop/CRM GDO" && npm test && npx tsc --noEmit && npm run lint
```

- [ ] **Step 2: Chiedi il via a Bruno**, dichiarando l'ora esatta in cui il nuovo comportamento entra in vigore. La Task 8 cambia cosa il lead legge in chat: senza il suo ok non si pusha.

- [ ] **Step 3: Push**

```bash
cd "C:/Users/bruno/Desktop/CRM GDO" && git push origin main
cd "C:/Users/bruno/Desktop/Software Messaggistica" && git push origin main
git fetch origin && git rev-list --count origin/main..main   # deve dare 0
```

- [ ] **Step 4: Verifica a 24 ore**

```sql
-- nessun richiamo nuovo su lead umani
select count(*) from leads l join users u on u.id=l."assignedToId" and u."isBot"=false
where l."recallDate" is not null and l."updatedAt" > now() - interval '24 hours'
  and l."recallNote" ilike '%Sequenza WhatsApp%';
-- atteso: 0
```

E sul cantiere 1, che nessuno venga più buttato via dopo aver prenotato:

```
event_log?type=eq.restituzione_bloccata_conferma_form&created_at=gte.<ieri>
```

Atteso: zero o poche righe — sono i casi in cui la rete ha dovuto intervenire perché il
prompt non aveva fissato. Se sono tante, il prompt della Task 4 non sta funzionando e va
rivisto: la rete è l'ultima difesa, non il meccanismo normale.

Rimisura poi il tasso di perdita con `quanti_noemi.py` (scratchpad di sessione):
**atteso sotto il 5%**, contro il 14% di settembre. Sotto quella soglia il cantiere è chiuso.

E sul DB del bot, che le tre fasce si vedano:

```
event_log?type=in.(richiamo_tenuto_aperto,richiamo_restituito,richiamo_restituito_nota_fallita,richiamo_restituito_nota_saltata,richiamo_scartato)&created_at=gte.<ieri>
```

Atteso: righe nei tre tipi, e **zero** `richiamo_con_periodo` nuovi.

---

## Fuori perimetro (da aprire a parte, se Bruno vuole)

- **Il webhook del form.** JotForm non scrive da nessuna parte: quello che il lead sceglie sul form non arriva né al bot né al CRM, ed è per questo che l'appuntamento dipende dal tag del modello. Un webhook `JotForm → /api/bot/form-submit` chiuderebbe la classe intera di bug. **Il PO ha deciso il 22/09 di non farlo ora.**
- **`booked_without_outcome` oltre la conferma del form.** 197 eventi in 14 giorni su 150 chat (79% si riprendono da soli). La Parte 1 copre i casi che passano dal form; restano quelli in cui il modello intuisce l'appuntamento senza leggerne la data per altre strade.
- **I gemelli per telefono si continueranno a creare.** La bonifica chiude i 152 di oggi, non la causa: il CRM tiene più lead per lo stesso numero, il bot ne tiene uno. Serve la decisione se l'intake debba rifiutare un telefono già in casa.
- **I telefoni non chiamabili entrano ancora.** `phoneSuspicious` esiste già all'intake ma non blocca: 26 lead con `3`, `32`, `0000000000` e numeri fissi sono arrivati fino al bot.
