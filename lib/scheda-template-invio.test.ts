import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./template-account', () => ({ traduciTemplate: vi.fn(async (sid: string) => ({ sid, tradotto: true })) }));
vi.mock('./twilio-account', () => ({ credenzialiPerMittente: vi.fn(() => ({ sid: 'AC1', token: 't' })) }));
vi.mock('./spedibilita', () => ({ spedibileDa: vi.fn(async () => ({ ok: true, sidTradotto: 'x' })) }));

import { aperturaScheda } from './scheda-template-invio';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function approvazione(status: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ whatsapp: { status, category: 'UTILITY' } }) })));
}

describe('aperturaScheda: spenta finche\' non e\' accesa e approvata', () => {
  const from = 'whatsapp:+393522070047';
  it('spenta di default: null senza chiedere niente a Twilio', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect(await aperturaScheda({ from, firstName: 'Ana', professione: 'video_editor' }, { SCHEDA_TEMPLATE_SID: 'HXA' })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('accesa ma SID mancante: null', async () => {
    approvazione('approved');
    expect(await aperturaScheda({ from, firstName: 'Ana', professione: null }, { SCHEDA_TEMPLATE_ENABLED: '1', SCHEDA_TEMPLATE_SID: 'HXA' })).toBeNull();
  });
  it('accesa ma non approvata: null', async () => {
    approvazione('pending');
    expect(await aperturaScheda({ from, firstName: 'Ana', professione: 'video_editor' }, { SCHEDA_TEMPLATE_ENABLED: '1', SCHEDA_TEMPLATE_SID: 'HXP' })).toBeNull();
  });
  it('accesa e approvata: la variante giusta col suo SID', async () => {
    approvazione('approved');
    const a = await aperturaScheda({ from, firstName: 'Ana Rossi', professione: 'video_editor' }, { SCHEDA_TEMPLATE_ENABLED: '1', SCHEDA_TEMPLATE_SID: 'HXOK' });
    expect(a).toMatchObject({ tipo: 'scheda', sid: 'HXOK', variabili: { '2': 'Video Editor', '3': 'video-editor.pdf' } });
    const b = await aperturaScheda({ from, firstName: 'Naomi', professione: 'boh' }, { SCHEDA_TEMPLATE_ENABLED: '1', SCHEDA_SCELTA_TEMPLATE_SID: 'HXB' });
    expect(b).toMatchObject({ tipo: 'scelta_corso', sid: 'HXB' });
  });
});
