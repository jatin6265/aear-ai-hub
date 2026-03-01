import OpenAI from 'openai';
import { getSupabaseService } from '../../lib/supabase';

export type RoutedDomain = 'finance' | 'hr' | 'devops' | 'crm' | 'general';

export type RoutedAgent = {
  id: string;
  name: string;
  domain: string;
  status: string;
  config: Record<string, unknown>;
};

export async function routeToAgent(query: string, tenantId: string): Promise<RoutedAgent | null> {
  const domain = await classifyDomain(query);
  const supabase = getSupabaseService();

  const { data: domainAgent } = await supabase.getClient()
    .from('ai_agents')
    .select('id, name, domain, status, config')
    .eq('tenant_id', tenantId)
    .eq('domain', domain)
    .eq('status', 'ready')
    .limit(1)
    .maybeSingle();

  if (domainAgent) {
    return normalizeAgent(domainAgent as Record<string, unknown>);
  }

  const { data: fallback } = await supabase.getClient()
    .from('ai_agents')
    .select('id, name, domain, status, config')
    .eq('tenant_id', tenantId)
    .neq('status', 'disabled')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return fallback ? normalizeAgent(fallback as Record<string, unknown>) : null;
}

export async function classifyDomain(query: string): Promise<RoutedDomain> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return 'general';

  const openai = new OpenAI({ apiKey });

  try {
    const response = await openai.chat.completions.create({
      model: process.env.ROUTER_MODEL ?? 'gpt-4.1-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Classify user query into one domain: finance, hr, devops, crm, general.',
            'Return JSON only: {"domain":"...","confidence":0.0}',
          ].join(' '),
        },
        { role: 'user', content: query },
      ],
      max_tokens: 60,
    });

    const raw = String(response.choices[0]?.message?.content ?? '{}');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const domain = String(parsed.domain ?? 'general').toLowerCase();
    if (domain === 'finance' || domain === 'hr' || domain === 'devops' || domain === 'crm' || domain === 'general') {
      return domain;
    }
    return 'general';
  } catch {
    return 'general';
  }
}

function normalizeAgent(row: Record<string, unknown>): RoutedAgent {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? 'OpsAI Agent'),
    domain: String(row.domain ?? 'general'),
    status: String(row.status ?? 'ready'),
    config: asRecord(row.config),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
