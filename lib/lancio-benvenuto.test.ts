import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTemplateBody = vi.fn<(sid: string, from?: string | null) => Promise<string | null>>();
vi.mock('./twilio', () => ({
  getTemplateBody: (sid: string, from?: string | null) => getTemplateBody(sid, from),
}));

import { contaVariabili, componiBenvenutoLancio, messaggioBenvenutoNonComponibile } from './lancio-benvenuto';
import { lancioBenvenutoText } from './lancio-fase';

/** I SID veri: il v2 è quello approvato UTILITY il 20/09/2026, a due variabili. */
const V1 = 'HX03b5c6a365331cd547c1c22cbedf2c64';
const V2 = 'HXcf2f16a2afbdafda977f188507599566';
const ZOOM = 'https://us06web.zoom.us/j/89845223337';

const CORPO_V2 =
  "Ciao {{1}}, confermo la tua iscrizione alla live Web Developer AI di lunedi' 5 ottobre alle " +
  "21:00. Questo e' il link per collegarti: {{2}} - te lo ricordiamo anche il giorno stesso.";

beforeEach(() => {
  getTemplateBody.mockReset();
  getTemplateBody.mockResolvedValue(null);
});

describe('contaVariabili', () => {
  it('conta i segnaposto del template, spazi nelle graffe compresi', () => {
    expect(contaVariabili('Ciao {{1}}, come stai?')).toBe(1);
    expect(contaVariabili(CORPO_V2)).toBe(2);
    expect(contaVariabili('Ciao {{ 1 }}, il link e {{2}}')).toBe(2);
    expect(contaVariabili('nessun segnaposto')).toBe(0);
  });

  // Un template con un buco in mezzo non lo sappiamo riempire, e deve risultare tale.
  it("l'indice piu' alto comanda, anche con un numero saltato", () => {
    expect(contaVariabili('Ciao {{1}}, vedi {{3}}')).toBe(3);
  });
});

describe('componiBenvenutoLancio', () => {
  it('template a due variabili col link: nome, link e corpo risolto', async () => {
    getTemplateBody.mockResolvedValue(CORPO_V2);
    const esito = await componiBenvenutoLancio({ templateSid: V2, nome: 'ANNA BIANCHI', zoomLink: ZOOM });

    expect(esito).toMatchObject({ ok: true, variabili: 2, variables: { '1': 'Anna', '2': ZOOM } });
    expect(esito.ok && esito.corpo).toContain(ZOOM);
    expect(esito.ok && esito.corpo).not.toContain('{{');
  });

  // Il caso da evitare: 342 persone con un buco al posto del link.
  it('template a due variabili senza link: non si manda', async () => {
    getTemplateBody.mockResolvedValue(CORPO_V2);
    expect(await componiBenvenutoLancio({ templateSid: V2, nome: 'Anna', zoomLink: null }))
      .toEqual({ ok: false, motivo: 'link_mancante', variabili: 2 });
    // Una stringa di spazi non e' un link.
    expect(await componiBenvenutoLancio({ templateSid: V2, nome: 'Anna', zoomLink: '   ' }))
      .toEqual({ ok: false, motivo: 'link_mancante', variabili: 2 });
  });

  it('template a una variabile: comportamento di sempre, il link non entra', async () => {
    getTemplateBody.mockResolvedValue('Ciao {{1}}, benvenuto.');
    const esito = await componiBenvenutoLancio({ templateSid: V1, nome: 'ANNA BIANCHI', zoomLink: ZOOM });

    expect(esito).toEqual({ ok: true, variabili: 1, variables: { '1': 'Anna' }, corpo: 'Ciao Anna, benvenuto.' });
  });

  // Indovinare cosa va in {{3}} e' lo stesso buco di prima, con un numero diverso.
  it('template con variabili che non conosciamo: non si manda', async () => {
    getTemplateBody.mockResolvedValue('Ciao {{1}}, link {{2}}, mistero {{3}}');
    expect(await componiBenvenutoLancio({ templateSid: 'HXignoto', nome: 'Anna', zoomLink: ZOOM }))
      .toEqual({ ok: false, motivo: 'variabili_sconosciute', variabili: 3 });
  });

  describe('Content API non leggibile (la rete di sicurezza per SID)', () => {
    it('SID del v2: due variabili lo stesso, e senza link non parte', async () => {
      getTemplateBody.mockResolvedValue(null);
      const conLink = await componiBenvenutoLancio({ templateSid: V2, nome: 'Anna', zoomLink: ZOOM });
      expect(conLink).toMatchObject({ ok: true, variabili: 2, variables: { '1': 'Anna', '2': ZOOM } });
      expect(conLink.ok && conLink.corpo).toContain(ZOOM);

      expect(await componiBenvenutoLancio({ templateSid: V2, nome: 'Anna', zoomLink: null }))
        .toMatchObject({ ok: false, motivo: 'link_mancante' });
    });

    it('SID del v1: una variabile, testo storico', async () => {
      const esito = await componiBenvenutoLancio({ templateSid: V1, nome: 'ANNA BIANCHI', zoomLink: ZOOM });
      expect(esito).toMatchObject({ ok: true, variabili: 1, variables: { '1': 'Anna' } });
      expect(esito.ok && esito.corpo).toBe(lancioBenvenutoText('ANNA BIANCHI'));
    });

    // Un raffreddore della Content API non deve valere zero benvenuti: si resta al
    // comportamento di sempre (il nome e basta).
    it('SID sconosciuto: una variabile e testo storico, niente blocco', async () => {
      const esito = await componiBenvenutoLancio({ templateSid: 'HXmai_visto', nome: null, zoomLink: ZOOM });
      expect(esito).toMatchObject({ ok: true, variabili: 1, variables: { '1': 'a te' } });
      expect(esito.ok && esito.corpo).toBe(lancioBenvenutoText(null));
    });

    it('la lettura che esplode non propaga: si ripiega e basta', async () => {
      getTemplateBody.mockRejectedValue(new Error('rete giu'));
      expect(await componiBenvenutoLancio({ templateSid: V2, nome: 'Anna', zoomLink: ZOOM }))
        .toMatchObject({ ok: true, variabili: 2 });
    });
  });

  it('il template si chiede allaccount che lo possiede, senza mittente', async () => {
    getTemplateBody.mockResolvedValue(CORPO_V2);
    await componiBenvenutoLancio({ templateSid: V2, nome: 'Anna', zoomLink: ZOOM });
    expect(getTemplateBody).toHaveBeenCalledWith(V2, undefined);
  });
});

describe('messaggioBenvenutoNonComponibile', () => {
  it('dice quale conversazione, quale template e perche', () => {
    const m = messaggioBenvenutoNonComponibile('link_mancante', 42, V2);
    expect(m).toContain('conv 42');
    expect(m).toContain(V2);
    expect(m).toContain('lancio_zoom_link');
  });
});
