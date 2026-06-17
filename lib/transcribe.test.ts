import { describe, it, expect } from 'vitest';
import { isAudioInbound } from './transcribe';

describe('isAudioInbound', () => {
  it('vero per media audio', () => {
    expect(isAudioInbound({ NumMedia: '1', MediaContentType0: 'audio/ogg' })).toBe(true);
    expect(isAudioInbound({ NumMedia: '1', MediaContentType0: 'audio/mpeg' })).toBe(true);
  });
  it('falso senza media', () => {
    expect(isAudioInbound({ NumMedia: '0', Body: 'ciao' })).toBe(false);
    expect(isAudioInbound({})).toBe(false);
  });
  it('falso per media non audio (immagine)', () => {
    expect(isAudioInbound({ NumMedia: '1', MediaContentType0: 'image/jpeg' })).toBe(false);
  });
});
