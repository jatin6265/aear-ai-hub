import { getSupabaseService } from '../../lib/supabase';
import { getRetriever } from '../../pipeline/retriever';

export type HybridContext = {
  semantic: Array<{ content: string; source_kind: string; similarity: number }>;
  structured: Array<{ entity: string; description: string; risk_level: string; sensitivity: string[] }>;
  timeline: Array<{ content: string; source_kind: string; occurred_at: string | null }>;
  schema: string;
  userRole: string;
  allowedResources: string[];
};

export async function buildHybridContext(input: {
  query: string;
  tenantId: string;
  userId: string;
  limit?: number;
}): Promise<HybridContext> {
  const supabase = getSupabaseService();
  const retriever = getRetriever();
  const cleanQuery = String(input.query ?? '').trim();
  const tokens = tokenize(cleanQuery);

  const [retrieved, timelineRows, schemaRows, structuredRows, raciContext] = await Promise.all([
    retriever.search(input.tenantId, cleanQuery, { limit: input.limit ?? 10 }),
    supabase.getClient()
      .from('context_events')
      .select('content, source_type, occurred_at')
      .eq('tenant_id', input.tenantId)
      .order('occurred_at', { ascending: false })
      .limit(20),
    supabase.getClient()
      .from('schema_entities')
      .select('name, description, entity_group, risk_level, sensitivity')
      .eq('tenant_id', input.tenantId)
      .order('updated_at', { ascending: false })
      .limit(40),
    loadStructuredEntityHints(input.tenantId, tokens),
    supabase.getClient().rpc('resolve_user_raci_context', {
      p_resource: 'agent_execution',
      p_action: 'execute',
      p_tenant_id: input.tenantId,
      p_user_id: input.userId,
    }),
  ]);

  const semantic = retrieved
    .filter((item) => item.source_kind !== 'event')
    .slice(0, 8)
    .map((item) => ({
      content: item.content,
      source_kind: item.source_kind,
      similarity: Number(item.similarity || 0),
    }));

  const timeline = ((timelineRows.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    content: String(row.content ?? ''),
    source_kind: String(row.source_type ?? 'event'),
    occurred_at: typeof row.occurred_at === 'string' ? row.occurred_at : null,
  })).filter((row) => row.content.length > 0);

  const schemaData = ((schemaRows.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    entity_group: String(row.entity_group ?? ''),
  })).filter((row) => row.name.length > 0);

  const schema = schemaData
    .slice(0, 20)
    .map((row) => `- ${row.name}${row.entity_group ? ` [${row.entity_group}]` : ''}: ${row.description || 'no description'}`)
    .join('\n');

  const raciRow = asRecord(Array.isArray(raciContext.data) ? raciContext.data[0] : raciContext.data);
  const allowedResources = Array.from(new Set([
    ...stringArray(raciRow.matched_roles),
    ...stringArray(raciRow.effective_roles),
  ])).filter((value) => value.length > 0);

  return {
    semantic,
    structured: structuredRows,
    timeline,
    schema,
    userRole: String(raciRow.profile_role ?? 'member'),
    allowedResources,
  };
}

async function loadStructuredEntityHints(
  tenantId: string,
  tokens: string[]
): Promise<Array<{ entity: string; description: string; risk_level: string; sensitivity: string[] }>> {
  const supabase = getSupabaseService();

  if (tokens.length === 0) {
    const { data } = await supabase.getClient()
      .from('schema_entities')
      .select('name, description, risk_level, sensitivity')
      .eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false })
      .limit(6);

    return normalizeStructuredRows(data ?? []);
  }

  const patterns = tokens.slice(0, 5);
  const batches = await Promise.all(patterns.map((token) => {
    return supabase.getClient()
      .from('schema_entities')
      .select('name, description, risk_level, sensitivity')
      .eq('tenant_id', tenantId)
      .ilike('name', `%${token}%`)
      .limit(4);
  }));

  const rows: Array<Record<string, unknown>> = [];
  for (const batch of batches) {
    if (!batch.error && Array.isArray(batch.data)) {
      rows.push(...(batch.data as Array<Record<string, unknown>>));
    }
  }

  const deduped = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = String(row.name ?? '').toLowerCase();
    if (key && !deduped.has(key)) deduped.set(key, row);
  }

  return normalizeStructuredRows([...deduped.values()].slice(0, 8));
}

function normalizeStructuredRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({
    entity: String(row.name ?? ''),
    description: String(row.description ?? ''),
    risk_level: String(row.risk_level ?? 'low'),
    sensitivity: stringArray(row.sensitivity),
  })).filter((row) => row.entity.length > 0);
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
}
