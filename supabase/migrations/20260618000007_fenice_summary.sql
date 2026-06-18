-- Riassunto AI del lead, generato on-demand e messo in cache sulla conversazione.

alter table conversations
  add column if not exists ai_summary    text,
  add column if not exists ai_summary_at timestamptz;
