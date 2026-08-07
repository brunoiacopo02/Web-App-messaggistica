# Chiusura ferragosto: il bot non fissa in giorni in cui non c'è nessuno

**Data:** 2026-08-07
**Branch:** `fix/chiusura-ferragosto` (worktree isolato da `main`)

## Il problema

Fenice Academy accetta appuntamenti **fino a lunedì 10 agosto compreso**. Da **martedì 11
a lunedì 17** non c'è nessuno a farli. Si riparte **martedì 18**.

`lib/booking-slots.ts` oggi propone sempre e soltanto "domani" e "dopodomani", saltando la
domenica, con rotazione dell'agenda alle 20:00. Senza intervento:

| Momento | Propone | Esito |
|---|---|---|
| ven 7 dopo le 20, sab 8, dom 9 | lun 10 + mar 11 | martedì 11 è già chiuso |
| lun 10 → dom 16 | da mar 11 a lun 17 | **ogni proposta cade nel vuoto** |
| lun 17 | mar 18 + mer 19 | corretto per caso |

Il danno grosso non è il martedì 11: è la settimana intera in cui il bot fisserebbe
appuntamenti a cui non si presenta nessuno da parte nostra.

## Cosa NON è in scope

- **Bonifica degli appuntamenti già presi nella finestra 11-17:** non possono esistere.
  Il bot non fissa mai oltre due giorni, quindi al 7 agosto la data più lontana in agenda
  è lunedì 10.
- **Promemoria pre-call:** nessuna modifica. Non c'è niente da sopprimere.
- **`RICHIAMO`:** nessuna modifica. I richiami li rilavora il bot stesso
  (`bot_scheduled_at`), non un umano in ferie.
- **Routing dei lead verso il bot:** questo repo accetta già qualunque lead il CRM gli
  spinga (`parseIntakePayload` filtra solo `companyId === 'fenice'`). La scelta di quali
  lead spingere è del CRM ed è una richiesta operativa, non una modifica di codice.
- **Restituzione dei lead ai GDO:** invariata. `INTERROTTO` e gli altri esiti continuano
  ad andare al CRM come sempre e i lead vengono ridistribuiti anche mentre i GDO non ci
  sono: li chiameranno al rientro. La chiusura riguarda solo la data che il bot può
  proporre, non il ciclo di vita del lead.
- **Nessun cron nuovo, nessuna coda di riaggancio.** Chi è pronto a fissare durante la
  chiusura viene fissato per il 18: un appuntamento in agenda è più caldo di una promessa,
  e i promemoria R24/R3 esistono già.

## Architettura

Tre file toccati, uno nuovo.

### `lib/booking-blackout.ts` (nuovo) — unica fonte di verità sui giorni chiusi

Sta in un file suo per due motivi: la responsabilità è distinta ("quali giorni sono
chiusi" ≠ "quali giorni propongo"), e il worktree `feat/pacchetto-post-fissaggio` sta già
modificando `booking-slots.ts` in parallelo — tenere la logica nuova fuori riduce il
conflitto di merge alle sole righe del testo.

```ts
export type BlackoutRange = { from: string; to: string }; // ISO date, estremi INCLUSI

export const BLACKOUT_DEFAULT: BlackoutRange[] = [{ from: '2026-08-11', to: '2026-08-17' }];

/** Parsa `2026-08-11:2026-08-17,2026-12-24:2026-12-26`. */
export function parseBlackout(raw: string | undefined): BlackoutRange[] | null;

/** Intervalli in vigore: env `BOOKING_BLACKOUT` se valida, altrimenti il default. */
export function bookingBlackout(env?: string | undefined): BlackoutRange[];

/** True se `isoDate` (YYYY-MM-DD) NON cade in nessun intervallo chiuso. */
export function isBookableDate(isoDate: string, ranges: BlackoutRange[]): boolean;
```

**Contratto di `parseBlackout`:**

| Input | Risultato | Perché |
|---|---|---|
| assente (`undefined`) | `null` → si usa `BLACKOUT_DEFAULT` | il blocco funziona anche se nessuno configura niente |
| stringa vuota o solo spazi | `[]` → **nessun blocco** | interruttore di spegnimento senza deploy |
| `2026-08-11:2026-08-20` | quell'intervallo | allungare/accorciare da Vercel |
| formato sporco, date invalide, `from > to` | `null` → default | una env sbagliata non deve rompere il bot |

Le date sono stringhe `YYYY-MM-DD` in fuso Europe/Rome, confrontate come stringhe: per
l'ISO 8601 l'ordinamento lessicografico coincide con quello cronologico.

### `lib/booking-slots.ts` (modifica) — il calcolo dei giorni

`computeBookingDays` mantiene ancoraggio e rotazione delle 20:00. Cambia solo il criterio
di avanzamento: `nextNonSunday` diventa **`nextBookable`** = primo giorno successivo che
non è domenica **e** non è chiuso.

Senza intervalli chiusi il comportamento è identico a oggi, bit per bit: i test esistenti
di `booking-slots.test.ts` restano invariati e devono restare verdi. Se si rompono, è
stato rotto il comportamento normale.

**Guardia:** la ricerca del giorno successivo si ferma a 60 giorni. Se non trova nulla
(configurazione assurda), si ignorano gli intervalli e si torna al calcolo semplice.
Meglio un bot che fissa che un bot che non fissa più niente mentre non c'è nessuno a
guardarlo.

Il tipo di ritorno guadagna due informazioni che servono al testo:

```ts
export type BookingDays = {
  day1: BookingDay;
  day2: BookingDay;
  /** day1 è il giorno immediatamente successivo all'ancora (nessun salto). */
  day1Imminente: boolean;
  /** Tra day1 e day2 c'è una chiusura: day2 non è il giorno utile successivo. */
  chiusuraDopoDay1: boolean;
  /** Ultimo giorno chiuso attraversato, se ce n'è uno (per il testo). */
  chiusuraFinoA: string | null;
};
```

### `lib/booking-slots.ts` — il testo iniettato nel prompt

`bookingSlotsContext(now)` produce tre forme.

**Forma normale** (nessuna chiusura in vista) — identica a oggi, parola per parola.

**Forma A — la chiusura cade subito dopo day1** (sabato 8 e domenica 9):

```
SLOT APPUNTAMENTO DISPONIBILI (la domenica non è mai disponibile, fuso Europe/Rome):
- lunedì 10/08/2026, dalle 15:00 alle 21:00 (ultimo slot alle 21:00)
CHIUSURA: dopo lunedì 10/08/2026 siamo chiusi fino a lunedì 17/08/2026 compreso.
Proponi SOLO lunedì 10/08/2026. Se serve dire perché, dì come stanno le cose: dopo lunedì
siamo chiusi per la settimana di ferragosto e si riparte martedì 18. È un fatto, non una
tecnica: dillo semplicemente, senza insistere su "affrettati".
Solo se il lead dice che lunedì non può, proponi martedì 18/08/2026, dalle 09:00 alle 21:00.
Nel tag [ESITO:APPUNTAMENTO|...] usa la data ISO 8601 del giorno scelto (2026-08-10 oppure
2026-08-18) con l'ora concordata e fuso +02:00.
```

**Forma B — siamo dentro la chiusura** (da lunedì 10 a domenica 16):

```
SLOT APPUNTAMENTO DISPONIBILI (la domenica non è mai disponibile, fuso Europe/Rome):
- martedì 18/08/2026, dalle 09:00 alle 21:00 (ultimo slot alle 21:00)
- mercoledì 19/08/2026, dalle 09:00 alle 21:00 (ultimo slot alle 21:00)
CHIUSURA: siamo chiusi fino a lunedì 17/08/2026 compreso. Se il lead chiede una data prima,
dì come stanno le cose: siamo fermi per la settimana di ferragosto, la prima data utile è
martedì 18/08/2026.
Nel tag [ESITO:APPUNTAMENTO|...] usa la data ISO 8601 del giorno scelto (2026-08-18 oppure
2026-08-19) con l'ora concordata e fuso +02:00.
```

**Fasce orarie.** Oggi day1 ha `15:00-21:00` perché è "domani" e la mattina è già andata,
day2 ha `09:00-21:00`. La regola diventa: **`15:00-21:00` solo se `day1Imminente`**,
altrimenti `09:00-21:00`. Un appuntamento a otto giorni ha la giornata intera libera.

### `lib/mario-prompt.ts` (modifica) — due riferimenti ai "due giorni"

Riga 218 dice `puoi fissare SOLO nei due giorni indicati` e `Proponi tu i due giorni`.
Diventano `nei giorni indicati` e `Proponi i giorni indicati`, più una frase: se il blocco
riporta una riga `CHIUSURA`, rispettala e di' la verità sul motivo. Modifica minima: il
prompt è già tarato, non si riscrive.

Riga 220 (`SE IL LEAD NON PUÒ in quegli slot`) resta com'è: gestisce già il rifiuto e
finisce a richiamo, che è il comportamento voluto anche qui.

## Onestà, non scarsità costruita

La chiusura è reale, quindi si dice. Mario non deve trasformarla in pressione ("ultimo
posto!", "solo per oggi"): dice il fatto e lascia decidere. La riga del prompt lo esplicita
perché un modello, davanti a una scadenza vera, tende a spingerci sopra.

## Test

TDD, `lib/booking-blackout.test.ts` nuovo + aggiunte a `lib/booking-slots.test.ts`.

**`booking-blackout`:**
- `parseBlackout(undefined)` → `null`; `''` e `'   '` → `[]`; formato valido → intervallo;
  più intervalli separati da virgola; `from > to` → `null`; `'ciao'` → `null`;
  `'2026-13-45:2026-08-17'` → `null`.
- `bookingBlackout(undefined)` → `BLACKOUT_DEFAULT`.
- `isBookableDate`: `2026-08-10` sì, `2026-08-11` no (primo giorno chiuso),
  `2026-08-14` no, `2026-08-17` no (ultimo giorno chiuso), `2026-08-18` sì.

**`booking-slots` (nuovi, col default in vigore):**
- ven 7 ago 20:00 Rome → day1 `2026-08-10`, day2 `2026-08-18`, `chiusuraDopoDay1` vero.
- sab 8 ago 10:00 → stessi valori.
- dom 9 ago 10:00 → stessi valori.
- lun 10 ago 10:00 → day1 `2026-08-18`, day2 `2026-08-19`, `day1Imminente` falso.
- ven 14 ago 10:00 → day1 `2026-08-18`, day2 `2026-08-19`.
- lun 17 ago 10:00 → day1 `2026-08-18`, day2 `2026-08-19`, `day1Imminente` vero.
- mar 18 ago 10:00 → day1 `2026-08-19`, day2 `2026-08-20`, nessuna chiusura nel testo.

**`bookingSlotsContext` (nuovi):**
- forma A (sab 8): contiene `CHIUSURA`, contiene `2026-08-10`, **non** elenca il 18 tra i
  giorni proponibili ma lo nomina come ripiego, e la fascia di lunedì è `15:00-21:00`.
- forma B (mer 12): elenca 18 e 19, entrambi `09:00-21:00`, contiene `CHIUSURA`.
- forma normale (22 giugno): il testo **non** contiene `CHIUSURA` — i test esistenti
  restano verdi senza modifiche.

**Regressione:** i 7 test attuali di `computeBookingDays` (date di giugno, nessun blocco)
non si toccano.

## Configurazione a deploy fatto

Variabile Vercel `BOOKING_BLACKOUT`, opzionale.

- Non impostarla → vale `2026-08-11:2026-08-17`. È il caso normale, non serve fare nulla.
- Riaprire prima o dopo → `BOOKING_BLACKOUT=2026-08-11:2026-08-19` (o la data giusta).
- Togliere il blocco → `BOOKING_BLACKOUT=` (stringa vuota).

Ogni cambio richiede un redeploy perché le env di Vercel entrano in vigore al deploy
successivo — ma non richiede toccare il codice.

## Nota di merge

`feat/pacchetto-post-fissaggio` modifica anch'esso il testo di `bookingSlotsContext`
(proposta un giorno alla volta, day2 solo su rifiuto di day1). Al merge il conflitto sarà
su quelle righe. Le due modifiche vanno nella stessa direzione: la forma A qui è già
"un giorno alla volta".
