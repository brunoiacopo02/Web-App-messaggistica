#!/usr/bin/env bun
/**
 * Screenshot QA della console di regia (Task 16a, anticipo del Task 16 Step 1).
 *
 * Fa login su /login, poi visita una lista di rotte (CLI args, o una lista di default)
 * a due viewport e nei due temi, salvando i PNG in .screens/. Segnala 404 (non fatale),
 * errori console del browser e risposte >= 400 (esclusi i 401 attesi prima del login).
 * Uscita 1 se ci sono stati errori JS o risposte 5xx.
 *
 * Uso:
 *   BASE_URL=http://localhost:3000 CONSOLE_EMAIL=... CONSOLE_PASSWORD=... bun scripts/screenshot-console.ts [rotta...]
 *
 * Se CONSOLE_EMAIL/CONSOLE_PASSWORD non sono impostate, le credenziali vengono lette da
 * C:/Users/bruno/Desktop/credenziali-console-admin.txt (righe "Email: ..." e "Password: ...").
 * La password non viene mai stampata né scritta nel repo.
 *
 * Nota Bun/Playwright: sotto Bun, il client CDP interno di Playwright si blocca in modo
 * indefinito sull'handshake WebSocket verso il browser (bug noto di compatibilità Bun↔Playwright,
 * non del sandbox: un WebSocket nativo di Bun verso lo stesso endpoint funziona, quello di
 * Playwright no). Per questo, se lo script viene lanciato con `bun` si rilancia da solo con
 * `node` (che gestisce nativamente i .ts), mantenendo intatto lo script npm `bun run screens`.
 */
if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
  const { spawnSync } = await import('node:child_process');
  const [scriptPath, ...cliArgs] = process.argv.slice(1);
  const risultato = spawnSync('node', ['--no-warnings', scriptPath, ...cliArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(risultato.status ?? 1);
}

import { chromium, type Browser, type ConsoleMessage, type Page, type Response } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const CREDENZIALI_FALLBACK = 'C:/Users/bruno/Desktop/credenziali-console-admin.txt';
const SCREENS_DIR = path.join(process.cwd(), '.screens');

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
] as const;

const TEMI = ['dark', 'light'] as const;

/** Le 9 viste della lista (lib/console/viste.ts): ognuna si fotografa con la sua prima chat aperta. */
const VISTE = ['serve_te', 'non_lette', 'errori', 'lancio', 'fissati_bot', 'mario', 'gdo', 'campagne', 'chiuse'] as const;

/** Le pagine della console (Serenamente è esclusa: sospesa). */
const PAGINE = [
  '/console/avvisi',
  '/console/lancio',
  '/console/assistente',
  '/console/impostazioni',
  '/console/analisi',
  '/console/simulatore',
  '/console/campagne',
  '/console/log',
];

interface Credenziali {
  email: string;
  password: string;
}

async function leggiCredenziali(): Promise<Credenziali> {
  const email = process.env.CONSOLE_EMAIL;
  const password = process.env.CONSOLE_PASSWORD;
  if (email && password) return { email, password };

  let testo: string;
  try {
    testo = await readFile(CREDENZIALI_FALLBACK, 'utf8');
  } catch {
    throw new Error(
      `Credenziali mancanti: imposta CONSOLE_EMAIL/CONSOLE_PASSWORD oppure crea ${CREDENZIALI_FALLBACK}`
    );
  }
  const rEmail = /^\s*Email:\s*(.+)\s*$/m.exec(testo);
  const rPassword = /^\s*Password:\s*(.+)\s*$/m.exec(testo);
  if (!rEmail || !rPassword) {
    throw new Error(`Impossibile trovare "Email:" e "Password:" in ${CREDENZIALI_FALLBACK}`);
  }
  return { email: rEmail[1].trim(), password: rPassword[1].trim() };
}

function slugRotta(rotta: string): string {
  return rotta
    .replace(/^\//, '')
    .replace(/[?=&]/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '_')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

interface Rilevazione {
  erroriConsole: { rotta: string; testo: string }[];
  risposteHttpErrore: { rotta: string; url: string; status: number }[];
  rotteNonTrovate: string[];
}

async function loggato(page: Page, credenziali: Credenziali): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', credenziali.email);
  await page.fill('#password', credenziali.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('button[type="submit"]'),
  ]);
  if (page.url().includes('/login')) {
    throw new Error('Login fallito: sono ancora su /login dopo il submit (credenziali? redirect?)');
  }
}

async function primoChatId(page: Page, vista: string): Promise<number | null> {
  await page.goto(`${BASE_URL}/console?vista=${vista}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const id = await page.evaluate(() => {
    const el = document.querySelector('[data-chat-id]');
    return el ? el.getAttribute('data-chat-id') : null;
  });
  return id ? Number(id) : null;
}

async function scattaRotta(
  browser: Browser,
  rotta: string,
  rilevazione: Rilevazione,
  loginState: string
): Promise<void> {
  for (const vp of VIEWPORTS) {
    for (const tema of TEMI) {
      const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        storageState: loginState,
      });
      await context.addInitScript((t) => {
        try {
          window.localStorage.setItem('console-tema', t);
        } catch {
          /* ignora: privacy mode / quota */
        }
      }, tema);

      const page = await context.newPage();

      page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() !== 'error') return;
        // Il browser logga da solo "Failed to load resource" per ogni risposta >= 400
        // (già tracciata da page.on('response') qui sotto, inclusi i 404 non fatali):
        // non è un errore JS dell'app, quindi non la duplichiamo tra gli errori.
        if (msg.text().startsWith('Failed to load resource')) return;
        rilevazione.erroriConsole.push({ rotta, testo: msg.text() });
      });
      page.on('response', (res: Response) => {
        const status = res.status();
        if (status === 401) return; // atteso prima del login, non ci interessa qui (siamo già loggati)
        if (status >= 400) {
          rilevazione.risposteHttpErrore.push({ rotta, url: res.url(), status });
        }
      });

      const url = `${BASE_URL}${rotta}`;
      const res = await page.goto(url, { waitUntil: 'networkidle' }).catch(() => null);

      if (res && res.status() === 404) {
        rilevazione.rotteNonTrovate.push(rotta);
        console.log(`[404] ${rotta} — rotta non ancora esistente, non fatale`);
        await context.close();
        continue;
      }

      await page.waitForTimeout(1500);

      const slug = slugRotta(rotta);
      const file = path.join(SCREENS_DIR, `${slug}-${vp.w}x${vp.h}-${tema}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`[ok] ${rotta} @ ${vp.w}x${vp.h} (${tema}) -> ${path.relative(process.cwd(), file)}`);

      await context.close();
    }
  }
}

async function main(): Promise<void> {
  const argRotte = process.argv.slice(2);
  await mkdir(SCREENS_DIR, { recursive: true });

  const credenziali = await leggiCredenziali();
  const browser = await chromium.launch();

  const rilevazione: Rilevazione = { erroriConsole: [], risposteHttpErrore: [], rotteNonTrovate: [] };

  try {
    const loginContext = await browser.newContext();
    const loginPage = await loginContext.newPage();
    await loggato(loginPage, credenziali);
    const loginState = path.join(SCREENS_DIR, '.storage-state.json');
    await loginContext.storageState({ path: loginState });

    const rotte = [...argRotte];

    if (argRotte.length === 0) {
      for (const vista of VISTE) {
        const chatId = await primoChatId(loginPage, vista);
        if (chatId != null) {
          rotte.push(`/console?vista=${vista}&chat=${chatId}`);
        } else {
          console.log(`[avviso] nessuna chat in "${vista}": la fotografo vuota`);
          rotte.push(`/console?vista=${vista}`);
        }
      }
      rotte.push(...PAGINE);
    }
    await loginContext.close();

    for (const rotta of rotte) {
      await scattaRotta(browser, rotta, rilevazione, loginState);
    }
  } finally {
    await browser.close();
  }

  console.log('\n--- Riepilogo ---');
  console.log(`Rotte non trovate (404): ${rilevazione.rotteNonTrovate.length}`);
  for (const r of rilevazione.rotteNonTrovate) console.log(`  - ${r}`);
  console.log(`Errori console browser: ${rilevazione.erroriConsole.length}`);
  for (const e of rilevazione.erroriConsole) console.log(`  - [${e.rotta}] ${e.testo}`);
  console.log(`Risposte HTTP >= 400: ${rilevazione.risposteHttpErrore.length}`);
  for (const e of rilevazione.risposteHttpErrore) console.log(`  - [${e.rotta}] ${e.status} ${e.url}`);

  const ci5xx = rilevazione.risposteHttpErrore.some((e) => e.status >= 500);
  if (rilevazione.erroriConsole.length > 0 || ci5xx) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
