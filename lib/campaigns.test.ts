import { describe, it, expect } from 'vitest';
import { matchCampaign, renderTemplateVariables, type CampaignRow } from './campaigns';
import type { AcParsedLead } from './ac';

const lead: AcParsedLead = {
  email: 'm@x.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: '+393331234567',
  acContactId: '1',
  listName: 'Webinar Marzo',
  listId: '7',
};

const campaigns: CampaignRow[] = [
  { id: 1, name: 'A', ac_list_match: 'Webinar Marzo', twilio_template_sid: 'HX1', template_variables: [], active: true },
  { id: 2, name: 'B', ac_list_match: '7',              twilio_template_sid: 'HX2', template_variables: [], active: true },
  { id: 3, name: 'C', ac_list_match: 'Inattivo',       twilio_template_sid: 'HX3', template_variables: [], active: false },
];

describe('matchCampaign', () => {
  it('trova match per listName', () => {
    expect(matchCampaign(campaigns, { ...lead, listId: null })?.id).toBe(1);
  });
  it('trova match per listId se listName non matcha', () => {
    expect(matchCampaign(campaigns, { ...lead, listName: 'altro' })?.id).toBe(2);
  });
  it('ignora campagne disattivate', () => {
    expect(matchCampaign(campaigns, { ...lead, listName: 'Inattivo', listId: null })).toBeNull();
  });
  it('ritorna null se nessun match', () => {
    expect(matchCampaign(campaigns, { ...lead, listName: 'X', listId: 'Y' })).toBeNull();
  });
});

describe('renderTemplateVariables', () => {
  it('mappa lead_field e static', () => {
    const vars = [
      { key: '1', source: 'lead_field', value: 'first_name' },
      { key: '2', source: 'static', value: 'Marzo 2026' },
      { key: '3', source: 'lead_field', value: 'last_name' },
    ] as const;
    const out = renderTemplateVariables(vars, lead);
    expect(out).toEqual({ '1': 'Mario', '2': 'Marzo 2026', '3': 'Rossi' });
  });

  it('lead_field mancante diventa stringa vuota', () => {
    const vars = [{ key: '1', source: 'lead_field' as const, value: 'first_name' as const }];
    const out = renderTemplateVariables(vars, { ...lead, firstName: null });
    expect(out).toEqual({ '1': '' });
  });

  it('mapping campi supportati', () => {
    const vars = [
      { key: '1', source: 'lead_field', value: 'email' },
      { key: '2', source: 'lead_field', value: 'phone' },
    ] as const;
    const out = renderTemplateVariables(vars, lead);
    expect(out).toEqual({ '1': 'm@x.it', '2': '+393331234567' });
  });
});
