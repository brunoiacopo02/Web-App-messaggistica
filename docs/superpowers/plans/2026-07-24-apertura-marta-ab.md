# Aperture per-funnel + persona Marta + A/B — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 6 aperture A/B per-funnel firmate "Marta", persona coerente su tutto lo stack, conversazioni Mario in-flight invariate, tutto dietro `NEW_OPENING_ENABLED`.

**Architecture:** Nuovo modulo puro `lib/persona.ts` (funnel→variante→testo, persona da template_sid). `fenice-enroll` sceglie il template; `sequence-touches` e `fenice-autoreply` derivano la persona dai messaggi. Nessuna migrazione DB.

**Tech Stack:** Next.js, TypeScript, Vitest, Twilio Content API.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-apertura-marta-ab-design.md` — i 6 testi delle aperture vanno copiati ESATTI da lì (placeholder nome = variabile template `{{1}}`).
- `NEW_OPENING_ENABLED !== '1'` ⇒ comportamento IDENTICO a oggi (Mario, template legacy). Zero regressioni.
- Conversazioni aperte da Mario restano Mario ovunque (touch, nudge, riaggancio, prompt).
- Etica: la persona non si dichiara umana né nega l'AI se chiesto (invariato nel prompt).
- Env nuove: `OPENING_SID_C1|C2|T1|T2|J1|J2`, `MARTA_SEQ_TEMPLATE_SID_1..4`, `MARTA_REENGAGE_TEMPLATE_SID`, `NEW_OPENING_ENABLED`.
- Fallback nome mancante nelle variabili template: `'benvenuto'` (mai osservato un lead CRM senza nome: 681/681 ce l'hanno).
- Test `npx vitest run <file>`, typecheck `npm run typecheck`, branch `feat/apertura-marta-ab`, commit frequenti con trailer Co-Authored-By.

---

### Task 1: `lib/persona.ts` + nudge persona-aware (TDD)

**Files:** Create `lib/persona.ts`, `lib/persona.test.ts`; Modify `lib/sequence.ts` (`pickNudgeText`), `lib/sequence.test.ts`.

**Produces (firme esatte):**
```ts
export type Persona = 'mario' | 'marta';
export type FunnelKey = 'corso10' | 'telegram' | 'jobsim' | 'other';
export function normalizeFunnel(f: string | null | undefined): FunnelKey;
  // 'CORSO 10 ORE'→corso10, 'TELEGRAM'|'TELEGRAM-TK'→telegram, 'JOB SIMULATOR'→jobsim,
  // match case-insensitive/trim; tutto il resto→other
export function variantIndexFor(conversationId: number): 1 | 2; // dispari→1, pari→2
export function openingEnvKey(funnel: FunnelKey, variant: 1 | 2): string;
  // corso10→OPENING_SID_C1/C2, telegram→T1/T2, jobsim→J1/J2, other→C1/C2
export function openingBody(funnel: FunnelKey, variant: 1 | 2, name?: string | null): string;
  // testo ESATTO della spec con {nome} sostituito (fallback 'benvenuto'); other=testi di corso10
export function personaForConversation(
  msgs: { direction: string; template_sid: string | null }[],
  martaSids: Set<string>,
): Persona; // 'marta' se il PRIMO out con template_sid è in martaSids, o se non c'è alcun out; altrimenti 'mario'
export const PERSONA_NAME: Record<Persona, string>; // { mario: 'Mario', marta: 'Marta' }
```
`pickNudgeText(conversationId, firstName, personaName?: string)`: terzo parametro opzionale
(default `'Mario'`), sostituisce il nome nelle 3 varianti esistenti.

- [ ] Test prima (normalizeFunnel per tutti i funnel reali del DB, parità, env key, body con/senza nome, personaForConversation: primo template marta→marta, legacy→mario, zero out→marta, out free-form senza template prima del template→ignora i non-template), poi implementazione, suite verde, typecheck, commit.

### Task 2: prompt parametrico

**Files:** Modify `lib/mario-prompt.ts`, `lib/fenice-autoreply.ts`; Test `lib/mario-prompt.test.ts` (create se assente).

- `lib/mario-prompt.ts`: esporta `buildMarioSystem(personaName: string): string` che genera il
  prompt attuale con il nome parametrico (righe "Sei Mario..." e "Presentati come Mario..."); il
  simbolo esistente consumato altrove resta = `buildMarioSystem('Mario')` (nessun call-site rotto).
- `lib/fenice-autoreply.ts`: dentro il drain, calcola `personaForConversation` sui messaggi già
  caricati (martaSids da env: le 6 OPENING + 4 MARTA_SEQ + MARTA_REENGAGE, filtrate undefined) e
  usa `buildMarioSystem(PERSONA_NAME[persona])`. Trova come il modulo ottiene oggi il system
  prompt (grep import di mario-prompt) e adatta SOLO il nome.
- [ ] Test: buildMarioSystem('Marta') contiene "Sei Marta" e "Presentati come Marta", non contiene "Mario"; default invariato. Run, typecheck, commit.

### Task 3: enroll con selezione template

**Files:** Modify `lib/fenice-enroll.ts`, `lib/fenice-enroll.test.ts`.

- Se `NEW_OPENING_ENABLED === '1'`: `funnel = normalizeFunnel(args.crmFunnel)`,
  `variant = variantIndexFor(conversationId)`, `sid = process.env[openingEnvKey(funnel, variant)]`,
  `body = openingBody(funnel, variant, firstName)`, variables `{'1': firstName?.trim() || 'benvenuto'}`,
  label `'Apertura ' + openingEnvKey(...)`. Se il SID env manca → fallback INTERO al ramo legacy
  (template Mario) + event_log `opening_config_error` level error, una volta per enroll.
- Flag spento → ramo attuale identico (assert nei test). Il differimento notturno (deferred) resta:
  in quel caso l'apertura la manda sequence-touches (Task 4).
- [ ] Test: flag on/off, funnel→SID giusto, parità variante, fallback SID mancante. TDD, typecheck, commit.

### Task 4: sequenza persona-aware

**Files:** Modify `app/api/cron/sequence-touches/route.ts`.

- `seqSids` per il CONTEGGIO touch = unione legacy `SEQ_TEMPLATE_SID_1..4` + `MARTA_SEQ_TEMPLATE_SID_1..4`.
- Persona per conv: `personaForConversation(msgs, martaSids)`. Touch: SID da set marta o legacy in
  base alla persona (indice touch invariato). Riaggancio: `MARTA_REENGAGE_TEMPLATE_SID` vs legacy.
  Nudge free: `pickNudgeText(c.id, firstName, PERSONA_NAME[persona])`.
- `send_opening` (aperture differite): se `NEW_OPENING_ENABLED==='1'` usa selezione Task 3 (stessa
  logica: normalizeFunnel su `crm_funnel` — AGGIUNGI `crm_funnel` alla select delle conversazioni —
  variante per parità id, body/SID/variabili come enroll); altrimenti legacy. RICHIAMO interim invariato.
- [ ] Typecheck + suite completa (nessun test route nel repo), commit.

### Task 5: report A/B

**Files:** Create `scripts/ab-report.mjs` (pattern createRequire + bot.env come scripts esistenti? NO: gli script di repo usano env di processo — usa `process.env` TWILIO/SUPABASE con istruzioni d'uso in testa al file).

- Per ogni SID di apertura (legacy + 6 nuovi, hardcoded via env con fallback ai nomi): conta conv
  con quel template come primo out, consegnati (delivered/read), % primo inbound ≤72h dall'invio,
  % bot_outcome='APPUNTAMENTO'. Stampa tabella testuale ordinata per funnel/variante.
- [ ] Prova a secco contro il DB (sola lettura), commit.

### Task 6 (MAIN SESSION): asset esterni + rollout

- [ ] Ritaglio quadrato foto scelta → `public/team-marta.jpg` (commit) → URL pubblico post-deploy.
- [ ] Crea via Content API: 6 template apertura (`fenice_open_{c1,c2,t1,t2,j1,j2}_marta_v1`, var {{1}}=Nome, testi ESATTI dalla spec) + 5 sequenza (`fenice_seq_touch1..4_marta_v1`, `fenice_reengage_marta_v1` = testi attuali con Marta al posto di Mario) e sottometti approvazione WhatsApp.
- [ ] `vercel env add` per tutti i SID + `NEW_OPENING_ENABLED=0`.
- [ ] Aggiorna profilo sender WhatsApp via Twilio API: foto (URL pubblico), descrizione, sito; verifica supporto typing indicator via docs/API Twilio (solo verifica, niente implementazione).
- [ ] Deploy, anteprima a Bruno (template approvati + foto), suo ok → `NEW_OPENING_ENABLED=1` + redeploy. Baseline pre-switch annotata (risposta 41,3%, fissati 8,1%).
