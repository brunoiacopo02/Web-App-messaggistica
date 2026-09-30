// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { Analisi } from './Analisi';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function risposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

const conteggi = { PRESO: 2, MAI_RISPOSTO: 5, ATTIVA: 3, FERMA: 1, total: 11 };

/** `fetch` finto: risponde per URL esatto e registra ogni URL chiesto. */
function fetchFinto(rotte: Record<string, () => Response>) {
  const chiesti: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    chiesti.push(url);
    const r = rotte[url];
    if (!r) throw new Error(`rotta inattesa ${url}`);
    return r();
  }));
  return chiesti;
}

async function monta(searchParams = '') {
  await act(async () => {
    render(
      <NuqsTestingAdapter searchParams={searchParams} hasMemory>
        <Analisi />
      </NuqsTestingAdapter>,
    );
  });
}

async function clic(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

it('parte da Attive con la stessa lettura di LeadPipeline e mostra i conteggi nelle schede', async () => {
  const chiesti = fetchFinto({
    '/api/fenice/segments?segment=ATTIVA&period=all': () => risposta({
      ok: true, counts: conteggi,
      rows: [{ id: 7, phone: '+393331112222', name: 'Anna Rossi', segment: 'ATTIVA', reason: null, lastMessageAt: '2026-09-30T08:00:00Z', status: null, scheduledAt: null }],
    }),
  });
  await monta();

  expect(chiesti).toEqual(['/api/fenice/segments?segment=ATTIVA&period=all']);
  const schede = screen.getByRole('tablist', { name: 'Segmenti e analisi' });
  expect(within(schede).getByRole('tab', { name: /Attive/ }).getAttribute('aria-selected')).toBe('true');
  expect(within(schede).getByRole('tab', { name: /Mai risposto/ }).textContent).toContain('5');
  const riga = screen.getByRole('row', { name: /Anna Rossi/ });
  expect(within(riga).getByRole('link', { name: /Apri/ }).getAttribute('href')).toBe('/console?chat=7');
});

it('Presi ordina per appuntamento, con le date in agenda e "Data da definire" in fondo', async () => {
  const chiesti = fetchFinto({
    '/api/fenice/segments?segment=ATTIVA&period=all': () => risposta({ ok: true, counts: conteggi, rows: [] }),
    '/api/fenice/segments?segment=PRESO&period=all': () => risposta({
      ok: true, counts: conteggi,
      rows: [
        { id: 1, phone: '+391', name: 'Senza data', segment: 'PRESO', reason: 'APPUNTAMENTO', lastMessageAt: '', status: null, scheduledAt: null },
        { id: 2, phone: '+392', name: 'Dopo', segment: 'PRESO', reason: 'APPUNTAMENTO', lastMessageAt: '', status: null, scheduledAt: '2026-10-02T08:00:00Z' },
        { id: 3, phone: '+393', name: 'Prima', segment: 'PRESO', reason: 'APPUNTAMENTO', lastMessageAt: '', status: null, scheduledAt: '2026-10-01T15:30:00Z' },
      ],
    }),
  });
  await monta();
  await clic(screen.getByRole('tab', { name: /Presi/ }));

  expect(chiesti.at(-1)).toBe('/api/fenice/segments?segment=PRESO&period=all');
  const nomi = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
  expect(nomi).toEqual(['Prima', 'Dopo', 'Senza data']);
  expect(screen.getByRole('row', { name: /Prima/ }).textContent).toContain('17:30');
  expect(screen.getByRole('row', { name: /Senza data/ }).textContent).toContain('Data da definire');
});

it('il periodo rilegge la scheda con period=7; Report legge la sua rotta e mostra le coppie', async () => {
  const chiesti = fetchFinto({
    '/api/fenice/segments?segment=ATTIVA&period=all': () => risposta({ ok: true, counts: conteggi, rows: [] }),
    '/api/fenice/segments?segment=ATTIVA&period=7': () => risposta({ ok: true, counts: conteggi, rows: [] }),
    '/api/fenice/report?period=7': () => risposta({
      ok: true, period: '7', total: 200, presi: 25, nonPresi: 175, conversionRate: 0.125,
      maiRisposto: 70, maiRispostoShareOfNonPresi: 0.4, bySegment: {},
      byFunnel: [{ funnel: 'webinar', total: 150, presi: 20 }, { funnel: 'meta', total: 50, presi: 5 }],
    }),
  });
  await monta();
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: 'Periodo' }), { target: { value: '7' } });
  });
  expect(chiesti.at(-1)).toBe('/api/fenice/segments?segment=ATTIVA&period=7');

  await clic(screen.getByRole('tab', { name: 'Report' }));
  expect(chiesti.at(-1)).toBe('/api/fenice/report?period=7');
  const coppie = document.querySelector<HTMLElement>('dl.an-kv')!;
  expect(within(coppie).getByText('Conversione').nextElementSibling?.textContent).toBe('12,5%');
  expect(screen.getByRole('row', { name: /webinar/ }).textContent).toContain('20');
});

it('Analisi AI mostra la lettura e le obiezioni come barre, senza chiamare altro che la GET salvata', async () => {
  const chiesti = fetchFinto({
    '/api/fenice/analysis': () => risposta({
      ok: true, generatedAt: '2026-09-29T20:00:00Z',
      report: {
        topObjections: [{ category: 'Prezzo', count: 12 }, { category: 'Tempo', count: 4 }],
        dropoffStages: [{ stage: 'Dopo il prezzo', count: 9 }],
        narrative: '**Sintesi**\nIl prezzo frena.',
      },
    }),
  });
  await monta('?scheda=ai');

  expect(chiesti).toEqual(['/api/fenice/analysis']);
  const obiezioni = screen.getByRole('list', { name: 'Obiezioni principali' });
  expect(within(obiezioni).getAllByRole('listitem')).toHaveLength(2);
  expect(within(obiezioni).getAllByRole('listitem')[0].textContent).toContain('Prezzo');
  const lettura = screen.getByRole('heading', { name: 'Lettura di Mario' }).nextElementSibling!;
  expect(within(lettura as HTMLElement).getByText('Sintesi', { selector: 'b' })).toBeTruthy();
  expect(lettura.textContent).toContain('Il prezzo frena.');
  expect(lettura.textContent).not.toContain('**');
});

it('una risposta 500 mostra l\'errore con Riprova, che rilegge', async () => {
  let volte = 0;
  const chiesti = fetchFinto({
    '/api/fenice/segments?segment=ATTIVA&period=all': () => {
      volte++;
      return volte === 1 ? risposta({ ok: false, error: 'timeout' }, 500) : risposta({ ok: true, counts: conteggi, rows: [] });
    },
  });
  await monta();
  expect(screen.getByText('Non riesco a leggere i lead')).toBeTruthy();

  await clic(screen.getByRole('button', { name: /Riprova/ }));
  expect(chiesti).toHaveLength(2);
  expect(screen.queryByText('Non riesco a leggere i lead')).toBeNull();
});
