import type { AcParsedLead } from './ac';

export type TemplateVariable =
  | { key: string; source: 'lead_field'; value: 'first_name' | 'last_name' | 'email' | 'phone' }
  | { key: string; source: 'static';     value: string };

export type CampaignRow = {
  id: number;
  name: string;
  ac_list_match: string;
  twilio_template_sid: string;
  template_variables: TemplateVariable[];
  active: boolean;
};

export function matchCampaign(
  campaigns: CampaignRow[],
  lead: Pick<AcParsedLead, 'listName' | 'listId'>,
): CampaignRow | null {
  const active = campaigns.filter(c => c.active);
  return (
    (lead.listName ? active.find(c => c.ac_list_match === lead.listName) : undefined) ??
    (lead.listId   ? active.find(c => c.ac_list_match === lead.listId)   : undefined) ??
    null
  );
}

const FIELD_MAP: Record<string, keyof AcParsedLead> = {
  first_name: 'firstName',
  last_name:  'lastName',
  email:      'email',
  phone:      'phone',
};

export function renderTemplateVariables(
  vars: readonly TemplateVariable[],
  lead: AcParsedLead,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars) {
    if (v.source === 'static') {
      out[v.key] = v.value;
    } else {
      const field = FIELD_MAP[v.value];
      const val = field ? lead[field] : null;
      out[v.key] = val ?? '';
    }
  }
  return out;
}
