-- Fix payload RPCs that perform seed writes from failing in read-only transactions.
-- These functions call seed/ensure helpers and must be VOLATILE.

ALTER FUNCTION public.get_raci_editor_payload() VOLATILE;
ALTER FUNCTION public.get_raci_role_management_payload() VOLATILE;
ALTER FUNCTION public.get_guardrails_risk_dashboard(text) VOLATILE;
