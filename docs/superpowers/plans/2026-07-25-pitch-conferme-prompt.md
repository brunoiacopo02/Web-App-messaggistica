# Pitch e conferme (solo prompt) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** riscrivere pitch, gestione del prezzo e blocco di conferma post-appuntamento nel prompt del bot, e rendere misurabile la visione del video pre-call.

**Architecture:** tutte le modifiche stanno in `lib/mario-prompt.ts` (stringa di sistema parametrica sulla persona), più un tag nuovo `[VIDEO_VISTO]` parsato in `lib/mario.ts` e loggato in `lib/fenice-autoreply.ts`. Nessuna migrazione DB, nessun template Meta, nessun cron: deployabile subito.

**Tech Stack:** TypeScript, Next.js App Router, Vitest, Supabase (solo `event_log`).

## Global Constraints

- Il prompt DEVE restare parametrico sulla persona: `buildMarioSystem('Marta').replace(/Marta/g,'Mario')` deve essere identico a `buildMarioSystem('Mario')` (test esistente). Nessun testo nuovo può contenere "Mario" o "Marta" hardcoded.
- Nessun testo nuovo può contenere cifre di rata, numero di rate, o analogie di frazionamento del prezzo (caffè, sigarette, "al giorno").
- Stile del prompt invariato: niente trattini come separatore, max 20-25 parole per messaggio, una sola domanda per messaggio, niente punto fermo sull'ultimo messaggio, niente liste nei testi che il bot invia.
- Copy esatto: `docs/superpowers/specs/2026-07-25-pitch-conferme-design.md`. Le stringhe vanno copiate da lì verbatim.
- I 4 link video per situazione del lead restano invariati (lavora/non lavora × con/senza famiglia).

---

## File Structure

- `lib/mario-prompt.ts` — MODIFY: FASE 5 (pitch), FASE 6 (anticipo + link), CONFERMA POST-APPUNTAMENTO, GESTIONE OBIEZIONI (prezzo), REGOLE ASSOLUTE (prezzi), nuova sezione "appuntamento già fissato", elenco tag.
- `lib/mario-prompt.test.ts` — MODIFY: nuovi test sul contenuto del prompt.
- `lib/mario.ts` — MODIFY: `parseMarioReply` riconosce `[VIDEO_VISTO]`, nuovo campo `videoWatched` in `MarioResult`.
- `lib/mario.test.ts` — MODIFY: test del nuovo tag.
- `lib/fenice-autoreply.ts` — MODIFY: inserisce l'evento `video_watched` quando il tag arriva.

---

### Task 1: Prezzo — pitch, regola assoluta, obiezione

**Files:**
- Modify: `lib/mario-prompt.ts` (FASE 5, REGOLE ASSOLUTE, GESTIONE OBIEZIONI)
- Test: `lib/mario-prompt.test.ts`

**Interfaces:**
- Consumes: `buildMarioSystem(personaName: string): string` (già esistente)
- Produces: nessuna nuova firma. Il prompt contiene le stringhe asserite dai test.

- [ ] **Step 1: Write the failing test**

In `lib/mario-prompt.test.ts`, aggiungi in fondo:

```typescript
describe('prezzo', () => {
  const p = buildMarioSystem('Marta');

  it('dice la quota intera e che si può rateizzare', () => {
    expect(p).toContain('dai 1.000 ai 3.000 euro a seconda del percorso');
    expect(p).toContain('si può rateizzare');
    expect(p).toContain('troviamo una soluzione praticamente con tutti');
  });

  it('vieta qualunque cifra di rata o numero di rate', () => {
    expect(p).toContain('MAI CIFRE DI RATA');
    expect(p).not.toMatch(/\d+\s*rate\b/i);
    // L'unica cifra "al mese" ammessa nel prompt è la forbice di guadagno
    // post-corso nella sezione CHI SIAMO. Qualunque altra sarebbe una rata.
    const alMese = p.match(/[\d.]+\s*(?:euro|€)\s*al mese/gi) ?? [];
    expect(alMese).toEqual(['5.000 euro al mese']);
  });

  it('vieta le analogie di frazionamento del prezzo', () => {
    expect(p).toContain('come un caffè al giorno');
    expect(p).toContain('meno di un pacchetto di sigarette');
    expect(p).toMatch(/non fare paragoni tipo/i);
  });

  it('propone la call subito dopo aver detto la quota', () => {
    expect(p).toContain('proponi la call nello stesso giro di messaggi');
  });

  it('lascia fare il conto al lead invece di minimizzare la spesa', () => {
    expect(p).toContain('quanto vale per te arrivarci?');
    expect(p).toContain('Il conto lo deve fare lui');
    expect(p).toMatch(/vietate frasi come "è solo", "è poco", "è un piccolo sacrificio"/);
  });
});
```

Nota: le due analogie compaiono nel prompt solo dentro il **divieto**, per questo i test le cercano; il test successivo (`non fare paragoni tipo`) verifica che siano in un contesto di divieto.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/mario-prompt.test.ts`
Expected: FAIL — le nuove stringhe non esistono, e `/\d+\s*rate\b/` matcha il testo attuale "rateizzare fino a 12 rate".

- [ ] **Step 3: Sostituisci il testo base della FASE 5**

In `lib/mario-prompt.ts`, sezione `FASE 5, PITCH`, sostituisci la riga `Testo base: "..."` con:

```
Testo base: "Fenice ha percorsi davvero completi, ti riassumo in due parole e poi ne parliamo con calma in una call ok? Sono fatti di tre cose: teoria, pratica e collegamento al lavoro. Le lezioni le guardi quando e dove vuoi, lo stage lo fai da remoto con orari flessibili, e a fine corso garantiamo a contratto due colloqui di lavoro con aziende nostre partner. La quota va dai 1.000 ai 3.000 euro a seconda del percorso, e si può rateizzare: sull'aspetto economico troviamo una soluzione praticamente con tutti. Ma la cosa più importante è prima capire se fa davvero per te."
```

- [ ] **Step 4: Sostituisci la regola PREZZI OBBLIGATORI**

Nella sezione `REGOLE ASSOLUTE`, sostituisci la riga che inizia con `PREZZI OBBLIGATORI:` con queste due righe:

```
PREZZI OBBLIGATORI: prima di proporre l'appuntamento DEVI aver comunicato la quota almeno una volta, cioè "la quota va dai 1.000 ai 3.000 euro a seconda del percorso, e si può rateizzare". Subito dopo averla detta proponi la call nello stesso giro di messaggi, senza aspettare che il lead reagisca al prezzo
MAI CIFRE DI RATA: non dire MAI quanto viene al mese, né quante rate sono, e non fare paragoni tipo "come un caffè al giorno" o "meno di un pacchetto di sigarette". Le rateizzazioni hanno interessi e condizioni diverse caso per caso: un numero detto in chat diventa una promessa che poi la call deve smentire. Se il lead chiede quanto viene al mese rispondi onesto, es. "dipende da come la imposti, non voglio spararti un numero a caso, in call te lo fanno vedere esatto"
```

- [ ] **Step 5: Sostituisci la gestione dell'obiezione prezzo**

Nella sezione `GESTIONE OBIEZIONI`, sostituisci la riga `"Costa troppo / non me lo posso permettere" → "..."` con:

```
"Costa troppo / non me lo posso permettere" → 1) valida senza difenderti: "eh lo so, è un investimento, ci sta". 2) riporta al SUO obiettivo con le SUE parole e lascia il conto a lui: "tu mi hai detto che [obiettivo suo], quanto vale per te arrivarci?". 3) àncora al fatto che sull'aspetto economico troviamo una soluzione praticamente con tutti e che lo vedete insieme in call. Non minimizzare MAI la spesa al posto suo: vietate frasi come "è solo", "è poco", "è un piccolo sacrificio". Il conto lo deve fare lui.
```

- [ ] **Step 6: Ripulisci le altre citazioni delle rate**

Cerca nel file ogni occorrenza residua di `12 rate` o `rateizzabili` e sostituiscila con `rateizzabile` senza numeri. In particolare la riga della gestione "materiale gratuito" contiene `(dai 1.000 ai 3.000 euro, rateizzabili)`: diventa `(dai 1.000 ai 3.000 euro, rateizzabile)`.

Run: `grep -n "rate" lib/mario-prompt.ts` e verifica che non resti nessuna cifra accanto a "rate".

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run lib/mario-prompt.test.ts`
Expected: PASS, inclusi i tre test di parametricità persona già esistenti.

- [ ] **Step 8: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "feat(pitch): quota intera + rateizzazione senza cifre, call subito dopo il prezzo"
```

---

### Task 2: Anticipo di Noemi e video + conferma post-appuntamento con micro-impegni

**Files:**
- Modify: `lib/mario-prompt.ts` (FASE 6 e CONFERMA POST-APPUNTAMENTO)
- Test: `lib/mario-prompt.test.ts`

**Interfaces:**
- Consumes: `buildMarioSystem(personaName: string): string`
- Produces: nessuna nuova firma.

- [ ] **Step 1: Write the failing test**

In `lib/mario-prompt.test.ts` aggiungi:

```typescript
describe('conferme: anticipo e micro-impegni', () => {
  const p = buildMarioSystem('Marta');

  it('anticipa Noemi e il video PRIMA di mandare il link', () => {
    expect(p).toContain('Prima di fissare ti dico come funziona');
    expect(p).toContain('Aspetta il sì, poi manda il link');
  });

  it('fa riscrivere giorno e ora al lead', () => {
    expect(p).toContain('Confermami tu giorno e ora della call');
  });

  it('sul video usa la scelta attiva invece del divieto', () => {
    expect(p).toContain('Quando riesci a vederlo, stasera o domani?');
    expect(p).not.toContain('Non è facoltativo');
    expect(p).not.toContain('non potrà essere effettuato');
  });

  it('chiede un FATTO scritto come conferma della visione', () => {
    expect(p).toContain("Scrivimi FATTO qui quando l'hai visto");
  });

  it('non minaccia il lead sulla chiamata di Noemi', () => {
    expect(p).toContain('Se ti scappa la chiamata non è un problema');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/mario-prompt.test.ts`
Expected: FAIL — nessuna di queste stringhe esiste, e `Non è facoltativo` è ancora presente.

- [ ] **Step 3: Inserisci l'anticipo in FASE 6**

In `FASE 6, APPUNTAMENTO`, subito PRIMA della riga `Quando accetta, manda il link:`, inserisci:

```
Quando accetta la call, PRIMA di mandare il link spiegagli come funziona e aspetta conferma:
"Perfetto. Prima di fissare ti dico come funziona, sono due cose veloci.
Prima della call ti chiama Noemi, una collega, per una preselezione di pochi minuti.
E c'è un video di 20 minuti da vedere prima, con le professioni, i pacchetti e le quote, così in call si parte dal tuo caso e non dalle basi.
Ti torna?"
Aspetta il sì, poi manda il link.
```

- [ ] **Step 4: Riscrivi il blocco CONFERMA POST-APPUNTAMENTO**

Sostituisci integralmente i tre messaggi numerati della sezione `CONFERMA POST-APPUNTAMENTO` con questi quattro passaggi:

```
1. "Perfetto, allora ci siamo. Confermami tu giorno e ora della call come li hai scelti, così sono sicuro che siamo allineati"

2. Dopo che ha confermato giorno e ora: "Noemi è la collega della preselezione, ti chiama prima della call: è il passaggio che conferma l'appuntamento, quindi tieni il telefono a portata. Se ti scappa la chiamata non è un problema, richiamala pure allo stesso numero"

3. Manda il link video giusto in base alla situazione del lead:
Lavora, senza famiglia: https://corso.feniceacademy.it/conferenza-bx
Non lavora, senza famiglia: https://corso.feniceacademy.it/conferenza-axmsbn9r50
Lavora, con famiglia: https://corso.feniceacademy.it/conferenza-dx
Non lavora, con famiglia: https://corso.feniceacademy.it/conferenza-ex
Poi: "Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20 minuti e servono perché in call partiamo dal tuo caso invece che dalle basi. Quando riesci a vederlo, stasera o domani?"

4. Quando risponde quando lo guarderà: "Perfetto. Scrivimi FATTO qui quando l'hai visto, così lo segno"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/mario-prompt.test.ts`
Expected: PASS. Se fallisce il test di parametricità, cerca "Mario"/"Marta" hardcoded nel testo appena inserito.

- [ ] **Step 6: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "feat(conferme): Noemi e video anticipati, micro-impegni al posto dell'obbligo"
```

---

### Task 3: Tag [VIDEO_VISTO] — parsing, comportamento post-fissaggio, log

**Files:**
- Modify: `lib/mario.ts:10-57` (tipo `MarioResult` e `parseMarioReply`)
- Modify: `lib/mario-prompt.ts` (nuova sezione + elenco tag)
- Modify: `lib/fenice-autoreply.ts` (insert evento, accanto al ramo `booked_without_outcome`)
- Test: `lib/mario.test.ts`, `lib/mario-prompt.test.ts`

**Interfaces:**
- Consumes: `parseMarioReply(raw: string): MarioResult`
- Produces: `MarioResult.videoWatched: boolean` — true se il testo grezzo conteneva `[VIDEO_VISTO]`; il tag è sempre rimosso da `visibleReply`.

- [ ] **Step 1: Write the failing test**

In `lib/mario.test.ts` aggiungi:

```typescript
describe('tag [VIDEO_VISTO]', () => {
  it('lo rileva e lo rimuove dal testo visibile', () => {
    const r = parseMarioReply('perfetto, allora ci vediamo in call [VIDEO_VISTO]');
    expect(r.videoWatched).toBe(true);
    expect(r.visibleReply).toBe('perfetto, allora ci vediamo in call');
  });

  it('senza tag resta false e non tocca il testo', () => {
    const r = parseMarioReply('ciao come va');
    expect(r.videoWatched).toBe(false);
    expect(r.visibleReply).toBe('ciao come va');
  });

  it('non declassa né confonde gli altri tag', () => {
    const r = parseMarioReply('ok [VIDEO_VISTO] [PASSAGGIO_UMANO]');
    expect(r.videoWatched).toBe(true);
    expect(r.passToHuman).toBe(true);
    expect(r.visibleReply).toBe('ok');
  });
});
```

In `lib/mario-prompt.test.ts` aggiungi:

```typescript
describe('comportamento a appuntamento già fissato', () => {
  const p = buildMarioSystem('Marta');

  it('vieta di ripartire col pitch e di riproporre la call', () => {
    expect(p).toContain("SE L'APPUNTAMENTO È GIÀ FISSATO");
    expect(p).toContain('non ripartire col pitch e non riproporre la call');
  });

  it('istruisce a emettere [VIDEO_VISTO] alla conferma del lead', () => {
    expect(p).toContain('[VIDEO_VISTO]');
  });

  it('manda a un umano le richieste di spostamento o disdetta', () => {
    expect(p).toContain('Se vuole spostare o disdire');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/mario.test.ts lib/mario-prompt.test.ts`
Expected: FAIL — `videoWatched` non esiste (errore di tipo/undefined) e le stringhe di prompt mancano.

- [ ] **Step 3: Aggiungi il campo al tipo e al parser**

In `lib/mario.ts`, aggiungi `videoWatched: boolean;` al tipo `MarioResult` (dopo `passToHuman`), poi dentro `parseMarioReply`:

```typescript
  const videoWatched = raw.includes('[VIDEO_VISTO]');
```

aggiungi alla catena di `visibleReply`:

```typescript
    .replace(/\[VIDEO_VISTO\]/g, '')
```

e includi `videoWatched` nell'oggetto ritornato.

- [ ] **Step 4: Aggiungi la sezione al prompt**

In `lib/mario-prompt.ts`, subito prima della sezione `GESTIONE OBIEZIONI`, inserisci:

```
SE L'APPUNTAMENTO È GIÀ FISSATO (hai già mandato Noemi e il video): non ripartire col pitch e non riproporre la call. Se il lead conferma di aver visto il video (es. "fatto", "visto", "l'ho guardato"), ringrazia in una riga e chiudi il messaggio con [VIDEO_VISTO]. Se vuole spostare o disdire non gestirlo da solo: digli che lo fai sistemare da un collega e usa [PASSAGGIO_UMANO]. Se fa una domanda sul percorso, rispondi breve e rimanda alla call.
```

Aggiorna anche la riga delle REGOLE ASSOLUTE che elenca i tag invisibili, aggiungendo `[VIDEO_VISTO]` accanto a `[APPUNTAMENTO_FISSATO]` e `[PASSAGGIO_UMANO]`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/mario.test.ts lib/mario-prompt.test.ts`
Expected: PASS.

- [ ] **Step 6: Logga l'evento**

Leggi prima `lib/fenice-autoreply.ts` intorno alla riga 194 per copiare lo stile dell'insert esistente. Poi, subito dopo il blocco che gestisce `result.passToHuman` e prima di `if (result.appointmentFixed)`, inserisci:

```typescript
      if (result.videoWatched) {
        await supabase.from('event_log').insert({
          type: 'video_watched',
          payload: { conversationId, crmLeadId } as never,
          message: `[bot-fissatore] conv ${conversationId}: il lead conferma di aver visto il video pre-call`,
          level: 'info',
        });
      }
```

Attenzione: NON deve interrompere il ciclo (niente `break`) e non deve cambiare `finalStatus`.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run` — Expected: tutti verdi
Run: `./node_modules/.bin/tsc --noEmit` — Expected: nessun output

- [ ] **Step 8: Commit**

```bash
git add lib/mario.ts lib/mario.test.ts lib/mario-prompt.ts lib/mario-prompt.test.ts lib/fenice-autoreply.ts
git commit -m "feat(conferme): tag VIDEO_VISTO, comportamento post-fissaggio, evento video_watched"
```

---

### Task 4: Verifica end-to-end del prompt

**Files:**
- Nessuna modifica prevista; solo verifica. Se emergono difetti, si correggono con un nuovo ciclo TDD.

- [ ] **Step 1: Rileggi il prompt**

Apri `lib/mario-prompt.ts` e rileggi dall'inizio di `FASE 5` fino alla fine di `REGOLE ASSOLUTE`, controllando a occhio:
- nessun trattino lungo o corto usato come separatore nei testi che il bot invia
- nessun messaggio del bot supera le ~25 parole
- ogni messaggio del bot termina con al massimo una domanda

- [ ] **Step 2: Verifica che non esistano numeri di rata**

Run: `grep -nE "[0-9]+ ?(euro|€) ?al mese|[0-9]+ rate|caffè|sigarette" lib/mario-prompt.ts`
Expected: solo le occorrenze dentro il **divieto** in REGOLE ASSOLUTE.

- [ ] **Step 3: Commit se sono servite correzioni**

```bash
git add -A && git commit -m "fix(prompt): rifiniture stile dopo rilettura"
```
