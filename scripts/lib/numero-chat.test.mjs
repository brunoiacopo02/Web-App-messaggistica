import { describe, it, expect, vi } from 'vitest';
import { allineaNumeroChatScript, mittenteScript, numeroChatDopoInvio } from './numero-chat.mjs';

const X = 'whatsapp:+393522070047';
const Y = 'whatsapp:+393520413199';

describe('mittenteScript — gli script massivi rispettano il numero della chat (06/11/2026)', () => {
  it('chat con un numero: si scrive da quello, non da FROM_OVERRIDE', () => {
    expect(mittenteScript(X, Y)).toBe(X);
  });
  it('chat senza numero: il predefinito dello script', () => {
    expect(mittenteScript(null, '+393520413199')).toBe(Y);
  });
  it('forzato (FORZA_MITTENTE=1): vince il predefinito', () => {
    expect(mittenteScript(X, Y, { forza: true })).toBe(Y);
  });
  it('niente di niente: null, lo script non manda', () => {
    expect(mittenteScript(null, '')).toBeNull();
  });
});

describe('allineaNumeroChatScript', () => {
  it('inviato da Y su una chat di X: PATCH wa_number=Y + evento', async () => {
    const sb = vi.fn(async () => null);
    expect(await allineaNumeroChatScript(sb, 5, X, Y, 'invio-agenda-gdo')).toBe(Y);
    expect(sb.mock.calls[0][0]).toBe('conversations?id=eq.5');
    expect(JSON.parse(sb.mock.calls[0][1].body)).toEqual({ wa_number: Y });
    expect(JSON.parse(sb.mock.calls[1][1].body).type).toBe('chat_segue_mittente');
  });
  it('stesso numero (anche con virgolette da .env): nessuna chiamata', async () => {
    const sb = vi.fn(async () => null);
    expect(await allineaNumeroChatScript(sb, 5, Y, '+393520413199', 'x')).toBeNull();
    expect(sb).not.toHaveBeenCalled();
    expect(numeroChatDopoInvio(Y, '"whatsapp:+393520413199"')).toBeNull();
  });
});
