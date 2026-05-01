import { z } from 'zod';

export const TemplateVarSchema = z.discriminatedUnion('source', [
  z.object({
    key: z.string().regex(/^\d+$/),
    source: z.literal('lead_field'),
    value: z.enum(['first_name', 'last_name', 'email', 'phone']),
  }),
  z.object({
    key: z.string().regex(/^\d+$/),
    source: z.literal('static'),
    value: z.string().min(1),
  }),
]);

export const CampaignSchema = z.object({
  name: z.string().min(1).max(200),
  ac_list_match: z.string().min(1).max(200),
  twilio_template_sid: z.string().regex(/^HX[a-zA-Z0-9]{32}$/, 'Formato Content SID non valido (HX...)'),
  template_variables: z.array(TemplateVarSchema).min(0).max(20),
  active: z.boolean().default(true),
});

export type CampaignInput = z.infer<typeof CampaignSchema>;

export const SendMessageSchema = z.discriminatedUnion('mode', [
  z.object({
    conversation_id: z.coerce.number().int().positive(),
    mode: z.literal('free'),
    body: z.string().min(1).max(4096),
  }),
  z.object({
    conversation_id: z.coerce.number().int().positive(),
    mode: z.literal('template'),
    template_id: z.coerce.number().int().positive(),
    vars: z.record(z.string(), z.string()).default({}),
  }),
]);

export type SendMessageInput = z.infer<typeof SendMessageSchema>;
