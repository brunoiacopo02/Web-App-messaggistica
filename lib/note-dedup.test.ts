import { describe, it, expect } from 'vitest';
import { noteFingerprint, crmDedupKey, divergiChiaveDaNotePrecedenti, type NotaCrmPrecedente } from './note-dedup';

describe('noteFingerprint: due note equivalenti hanno la stessa impronta', () => {
  it('ignora spazi doppi e spazi ai bordi', () => {
    expect(noteFingerprint('  Il lead  vuole annullare ')).toBe(noteFingerprint('Il lead vuole annullare'));
  });

  it('ignora le differenze di maiuscole', () => {
    expect(noteFingerprint('Il Lead Vuole Annullare')).toBe(noteFingerprint('il lead vuole annullare'));
  });

  it('distingue note con contenuto diverso', () => {
    const a = noteFingerprint('Il lead ha chiesto di spostare a martedì 28 luglio alle 17:00.');
    const b = noteFingerprint('Il lead ha chiesto di spostare a martedì 28 luglio alle 15:00.');
    expect(a).not.toBe(b);
  });

  it('e stabile fra chiamate diverse', () => {
    const n = 'Il lead vuole annullare l\'appuntamento (fissato per lunedì 27 luglio alle 13:00).';
    expect(noteFingerprint(n)).toBe(noteFingerprint(n));
  });

  it('gestisce la nota vuota senza esplodere', () => {
    expect(typeof noteFingerprint('')).toBe('string');
  });
});

describe('crmDedupKey: replica la chiave che deriva il CRM', () => {
  it('con "motivo:" nel testo, la chiave si ferma lì', () => {
    expect(crmDedupKey('Il lead ha detto motivo: non posso quel giorno.')).toBe('Il lead ha detto ');
  });

  it('"motivo:" scatta anche senza confine di parola, come nel parser del CRM', () => {
    expect(crmDedupKey('xilmotivo: resto uguale')).toBe('xil');
  });

  it('senza "motivo:", la chiave è la prima frase (fino al primo punto+spazio)', () => {
    expect(crmDedupKey('Prima frase. Seconda frase.')).toBe('Prima frase');
  });

  it('un punto non seguito da spazio non è un confine: non innesca la chiave', () => {
    // Verificato dal CRM: il loro confine richiede il punto seguito da spazio o da
    // fine testo, quindi un orario come "15.00" è già innocuo di suo.
    expect(crmDedupKey('La call è alle 15.00 di domani')).toBe('La call è alle 15.00 di domani');
  });

  it('senza "motivo:" e senza nessun punto+spazio, la chiave è l\'intera nota', () => {
    expect(crmDedupKey('nessun punto qui dentro')).toBe('nessun punto qui dentro');
  });
});

describe('divergiChiaveDaNotePrecedenti: il controllo esatto', () => {
  it('stessa chiave, impronta diversa → allunga finché la chiave diverge', () => {
    const precedenti: NotaCrmPrecedente[] = [{ chiave: 'Preambolo lungo e generico', fingerprint: 'fp-A' }];
    const nota = 'Preambolo lungo e generico. Fatto B, diverso da A.';
    const risultato = divergiChiaveDaNotePrecedenti(nota, 'fp-B', precedenti);

    expect(risultato.irriducibile).toBe(false);
    expect(risultato.chiave).not.toBe('Preambolo lungo e generico');
    // Il punto prematuro diventa una lineetta, non sparisce: si legge ancora tutto.
    expect(risultato.note).toContain('Preambolo lungo e generico —');
    expect(risultato.note).not.toMatch(/generico\. Fatto B/);
  });

  it('stessa chiave, stessa impronta → non tocca nulla: è lo stesso fatto re-inviato', () => {
    const precedenti: NotaCrmPrecedente[] = [{ chiave: 'Preambolo lungo e generico', fingerprint: 'fp-A' }];
    const nota = 'Preambolo lungo e generico. Fatto A, di nuovo.';
    const risultato = divergiChiaveDaNotePrecedenti(nota, 'fp-A', precedenti);

    expect(risultato.note).toBe(nota);
    expect(risultato.chiave).toBe('Preambolo lungo e generico');
    expect(risultato.irriducibile).toBe(false);
  });

  it('nessuna nota precedente → non tocca nulla', () => {
    const nota = 'Qualunque cosa. Con un punto pure.';
    const risultato = divergiChiaveDaNotePrecedenti(nota, 'fp-X', []);
    expect(risultato.note).toBe(nota);
    expect(risultato.irriducibile).toBe(false);
  });

  it('niente punti da spostare → non cicla e non rompe: spedisce e segnala irriducibile', () => {
    const precedenti: NotaCrmPrecedente[] = [{ chiave: 'Nessun punto qui dentro', fingerprint: 'fp-A' }];
    const nota = 'Nessun punto qui dentro'; // stessa chiave (fallback: intera nota), niente ". " da spostare
    const risultato = divergiChiaveDaNotePrecedenti(nota, 'fp-B', precedenti);

    expect(risultato.irriducibile).toBe(true);
    expect(risultato.note).toBe(nota); // spedita intatta, non inventato nessun taglio
    if (risultato.irriducibile) {
      expect(risultato.collisione).toEqual(precedenti[0]);
    }
  });

  it('non cicla all\'infinito quando le collisioni si susseguono (tetto di iterazioni)', () => {
    // Una nota patologica con tanti ". " ravvicinati: la funzione deve terminare.
    const nota = Array.from({ length: 30 }, (_, i) => `frase ${i}`).join('. ') + '.';
    const precedenti: NotaCrmPrecedente[] = [{ chiave: crmDedupKey(nota), fingerprint: 'fp-A' }];
    const inizio = Date.now();
    const risultato = divergiChiaveDaNotePrecedenti(nota, 'fp-B', precedenti);
    expect(Date.now() - inizio).toBeLessThan(1000);
    expect(typeof risultato.note).toBe('string');
  });

  // Il caso misurato dal team del CRM sul loro parser vero: due note che raccontano
  // fatti diversi sullo stesso lead condividono un preambolo di 100 caratteri, identico
  // parola per parola. La soglia di lunghezza (80) non interviene: 100 è già sopra. Solo
  // il controllo esatto — che confronta le note vere, non una loro lunghezza — se ne
  // accorge, perché guarda l'impronta del testo intero, non un proxy indiretto.
  it('caso misurato dal CRM: due note diverse con lo stesso preambolo di 100 caratteri escono con chiavi diverse', () => {
    const preambolo = 'Aggiornamento automatico dal bot fissatore relativo alla conversazione WhatsApp in corso con il lead.';

    const notaA = `${preambolo} Ha chiesto di spostare la call a giovedì.`;
    const notaB = `${preambolo} Ha dato un secondo recapito, 333 1234567.`;

    // Prima del controllo esatto (solo la soglia di lunghezza, qui simulata leggendo
    // direttamente crmDedupKey): la chiave è la stessa per A e per B, lunga 100
    // caratteri come misurato dal CRM — ben sopra la soglia di 80, che quindi non
    // interviene. È esattamente il buco che il CRM ha segnalato.
    expect(crmDedupKey(notaA)).toBe(crmDedupKey(notaB));
    expect(crmDedupKey(notaA).length).toBe(100);
    expect(crmDedupKey(notaA)).toBe(preambolo.slice(0, -1)); // fino al punto, senza il punto

    // A parte per prima: nessuna nota precedente, la chiave resta quella "naturale".
    const fingerprintA = 'fp-nota-A';
    const risultatoA = divergiChiaveDaNotePrecedenti(notaA, fingerprintA, []);
    expect(risultatoA.irriducibile).toBe(false);

    // B arriva dopo, sullo stesso lead, entro la finestra di dedup: collide con la
    // chiave di A ma è un fatto diverso (impronta diversa) → si allunga.
    const fingerprintB = 'fp-nota-B';
    const notePrecedenti: NotaCrmPrecedente[] = [{ chiave: risultatoA.chiave, fingerprint: fingerprintA }];
    const risultatoB = divergiChiaveDaNotePrecedenti(notaB, fingerprintB, notePrecedenti);
    expect(risultatoB.irriducibile).toBe(false);

    // Il punto: le chiavi finali di A e B DEVONO essere diverse, altrimenti la seconda
    // campanella alle Conferme non scatterebbe mai.
    expect(risultatoA.chiave).not.toBe(risultatoB.chiave);
  });
});
