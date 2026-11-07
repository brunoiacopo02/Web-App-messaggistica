-- Applicata il 07/11/2026 14:17 UTC via MCP: RLS senza policy (solo service_role).
-- Rollback: alter table ... disable row level security;
alter table public.app_settings enable row level security;
alter table public.lead_analysis_reports enable row level security;
