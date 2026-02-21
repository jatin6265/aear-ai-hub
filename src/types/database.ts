export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  region: string;
  created_at: string;
}

export interface Profile {
  id: string;
  tenant_id: string | null;
  full_name: string | null;
  role: string;
  avatar_url: string | null;
  created_at: string;
}

export interface ApiConnection {
  id: string;
  tenant_id: string;
  name: string;
  type: string;
  base_url: string | null;
  status: string;
  schema_detected: boolean;
  last_synced_at: string | null;
  created_at: string;
}

export interface ChatSession {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_used: string | null;
  risk_level: string | null;
  created_at: string;
}

export interface RaciEntry {
  id: string;
  tenant_id: string;
  resource: string;
  action: string;
  role_name: string;
  raci_type: 'R' | 'A' | 'C' | 'I';
}

export interface AuditLog {
  id: string;
  tenant_id: string;
  user_id: string | null;
  action: string;
  resource: string;
  risk_level: string | null;
  status: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface ApprovalRequest {
  id: string;
  tenant_id: string;
  requested_by: string;
  action: string;
  resource: string;
  params: Record<string, unknown> | null;
  simulation_preview: Record<string, unknown> | null;
  risk_level: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface Subscription {
  id: string;
  tenant_id: string;
  plan: string;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
}

export interface UsageEvent {
  id: string;
  tenant_id: string;
  metric_type: string;
  quantity: number;
  recorded_at: string;
}
