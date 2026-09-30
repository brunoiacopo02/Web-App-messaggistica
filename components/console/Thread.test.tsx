// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Thread } from './Thread';
import type { DettaglioChat } from '@/lib/console/thread';

afterEach(cleanup);

const base = (p: Partial<DettaglioChat> = {}): DettaglioChat => ({
  conv: {
    id: 1, aiOwner: 'mario', aiStatus: 'active', aiPausedAt: null, botOutcome: null, botScheduledAt: null,
    lancioFase: null, lancioSlug: null, waNumber: null, crmLeadId: null, aiSummary: null, handedOffReason: null,
    lastInboundAt: null, mondo: 'MARIO', unreadCount: 0, contesto: null,
  },
  lead: { id: 1, nome: 'Giulia Ferraresi', telefono: '+393334028817' },
  crm: null,
  eventi: [{ at: '2026-10-05T19:20:00Z', tipo: 'bot_paused', testo: '[chat] bot fermato sulla conv 1', livello: 'warn' }],
  eventiParziali: false,
  ...p,
});

const monta = (d: DettaglioChat) =>
  render(
    <Thread dettaglio={d} messaggi={[]} now={new Date('2026-10-05T20:00:00Z')} pausaInCorso={false}
      onPausa={() => {}} onInvia={async () => true} schedaAperta={false} onScheda={() => {}} />,
  );

describe('Thread: eventi', () => {
  it('la riga di sistema mostra la frase italiana, non il messaggio tecnico', () => {
    monta(base());
    expect(screen.getByText('Bot fermato')).toBeTruthy();
    expect(screen.queryByText(/\[chat\]/)).toBeNull();
    expect(screen.queryByText(/Eventi non caricati/)).toBeNull();
  });

  it('con eventiParziali mostra l\'avviso discreto', () => {
    monta(base({ eventi: [], eventiParziali: true }));
    expect(screen.getByText('Eventi non caricati: la lettura è lenta. Riapri la chat per riprovare.')).toBeTruthy();
  });
});
