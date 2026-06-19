import { describe, it, expect } from 'vitest';
import { parseReportJson } from './bot-report';

describe('parseReportJson', () => {
  it('estrae JSON anche con testo attorno', () => {
    const r = parseReportJson('Ecco: {"summary":"interessato","painPoints":["solitudine"],"urgency":"alta"} fine');
    expect(r.summary).toBe('interessato');
    expect(r.painPoints).toEqual(['solitudine']);
    expect(r.urgency).toBe('alta');
  });
  it('JSON non valido → oggetto vuoto', () => {
    expect(parseReportJson('niente json')).toEqual({});
  });
  it('campi non-array vengono scartati per painPoints/objections', () => {
    const r = parseReportJson('{"painPoints":"x","objections":["y"]}');
    expect(r.painPoints).toBeUndefined();
    expect(r.objections).toEqual(['y']);
  });
});
