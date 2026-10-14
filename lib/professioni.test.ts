import { describe, it, expect } from 'vitest';
import { isMarkerProfessioni, riconosciProfessione, isSlugProfessione, nomeProfessione, urlScheda, PROFESSIONI } from './professioni';

const frase = (n: string) => `Ciao, sono interessato alla professione di ${n} e vorrei ricevere la scheda del corso`;

describe('professioni', () => {
  it('riconosce le 6 frasi del link', () => {
    expect(riconosciProfessione(frase('Sviluppatore Web AI'))).toBe('sviluppatore_web_ai');
    expect(riconosciProfessione(frase('Video Editor'))).toBe('video_editor');
    expect(riconosciProfessione(frase('Project Manager'))).toBe('project_manager');
    expect(riconosciProfessione(frase('Graphic Designer'))).toBe('graphic_designer');
    expect(riconosciProfessione(frase('Copywriter'))).toBe('copywriter');
    expect(riconosciProfessione(frase('Social Media Manager'))).toBe('social_media_manager');
    for (const p of PROFESSIONI) expect(isMarkerProfessioni(frase(p.nome))).toBe(true);
  });
  it('tollera varianti', () => {
    expect(riconosciProfessione('vorrei la scheda del corso di montaggio video')).toBe('video_editor');
    expect(riconosciProfessione('web developer, mi mandi la scheda?')).toBe('sviluppatore_web_ai');
    expect(riconosciProfessione('mi interessa la grafica')).toBe('graphic_designer');
    expect(riconosciProfessione('SMM')).toBe('social_media_manager');
  });
  it('null quando non c\'e\' un corso', () => {
    expect(riconosciProfessione('vorrei ricevere la scheda del corso')).toBeNull();
    expect(riconosciProfessione(null)).toBeNull();
  });
  it('il link del lancio non e\' un marker professioni', () => {
    expect(isMarkerProfessioni('Ciao, ho visto la professione dello Sviluppatore AI e vorrei più informazioni')).toBe(false);
  });
  it('slug, nome, url', () => {
    expect(isSlugProfessione('copywriter')).toBe(true);
    expect(isSlugProfessione('pizzaiolo')).toBe(false);
    expect(nomeProfessione('project_manager')).toBe('Project Manager');
    expect(urlScheda('video_editor', 'https://x.app')).toBe('https://x.app/schede/video-editor.pdf');
  });
});
