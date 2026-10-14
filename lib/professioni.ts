/**
 * Funnel Professioni (PO 14/10/2026, spec 2026-10-14-funnel-professioni-design.md): la
 * landing del marketing apre WhatsApp sul 3199 con "Ciao, sono interessato alla professione
 * di <Nome> e vorrei ricevere la scheda del corso". Unico catalogo dei sei corsi: lo usano
 * la classificazione del primo messaggio, la nota di Mario, l'invio del PDF e il sollecito.
 */
export const PROVENIENZA_PROFESSIONI = 'PROFESSIONI' as const;

export type SlugProfessione =
  | 'sviluppatore_web_ai' | 'video_editor' | 'project_manager'
  | 'graphic_designer' | 'copywriter' | 'social_media_manager';

export type Professione = { slug: SlugProfessione; nome: string; file: string; parole: RegExp };

// L'ordine conta: "social media manager" va provato prima di "project manager" e
// "sviluppatore" e' l'ultima spiaggia del web developer.
export const PROFESSIONI: readonly Professione[] = [
  { slug: 'social_media_manager', nome: 'Social Media Manager', file: 'social-media-manager.pdf', parole: /social\s*media\s*manager|\bsmm\b/i },
  { slug: 'project_manager', nome: 'Project Manager', file: 'project-manager.pdf', parole: /project\s*manager/i },
  { slug: 'video_editor', nome: 'Video Editor', file: 'video-editor.pdf', parole: /video\s*-?\s*editor|montaggio\s+video/i },
  { slug: 'graphic_designer', nome: 'Graphic Designer', file: 'graphic-designer.pdf', parole: /graphic\s*designer|\bgrafic[ao]\b/i },
  { slug: 'copywriter', nome: 'Copywriter', file: 'copywriter.pdf', parole: /copy\s*-?\s*writer/i },
  { slug: 'sviluppatore_web_ai', nome: 'Sviluppatore Web AI', file: 'sviluppatore-web-ai.pdf', parole: /sviluppatore\s+web|web\s*developer|\bsviluppatore\b/i },
];

const MARKER = /scheda del corso/i;

export function isMarkerProfessioni(t: string | null | undefined): boolean {
  return MARKER.test(t ?? '');
}

export function riconosciProfessione(t: string | null | undefined): SlugProfessione | null {
  const testo = t ?? '';
  return PROFESSIONI.find((p) => p.parole.test(testo))?.slug ?? null;
}

export function isSlugProfessione(s: string | null | undefined): s is SlugProfessione {
  return PROFESSIONI.some((p) => p.slug === s);
}

export function nomeProfessione(slug: SlugProfessione): string {
  return PROFESSIONI.find((p) => p.slug === slug)!.nome;
}

/** URL pubblico del PDF: servito da `public/schede/` del bot. */
export function urlScheda(slug: SlugProfessione, base: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string {
  if (!base) throw new Error('Missing NEXT_PUBLIC_APP_URL');
  const file = PROFESSIONI.find((p) => p.slug === slug)!.file;
  return `${base.replace(/\/$/, '')}/schede/${file}`;
}
