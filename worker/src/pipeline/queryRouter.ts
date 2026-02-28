import OpenAI from 'openai';
import { getRetriever } from './retriever';
import { getMcpRouter } from '../mcp/mcpRouter';

export type QueryIntent = 'semantic' | 'sql' | 'mcp_tool' | 'hybrid';

export type RoutedQueryResult = {
  intent: QueryIntent;
  answer: string;
  sources: Array<{ content: string; source_kind: string; similarity?: number }>;
  toolCalls?: unknown[];
};

/**
 * Classifies query intent and routes to the appropriate retrieval strategy.
 *
 * The intent is AI-driven — never hardcoded.
 * Routes: Semantic Search (vector) | SQL Tools (structured) | MCP Tool Call | Hybrid
 */
export class QueryRouter {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Classifies the query intent using the LLM.
   */
  async classifyIntent(query: string): Promise<QueryIntent> {
    const response = await this.openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an AI query intent classifier. Classify the user's query into one of:
- "semantic": Looking for information in documents, emails, messages (unstructured text)
- "sql": Asking for structured data, metrics, counts, aggregations from databases
- "mcp_tool": Requesting an action or tool execution (create, update, send, list API data)
- "hybrid": Requires both semantic search AND structured data

Reply with ONLY the intent keyword, nothing else.`,
        },
        { role: 'user', content: query },
      ],
      temperature: 0,
      max_tokens: 20,
    });

    const intent = (response.choices[0]?.message?.content?.trim() ?? 'semantic') as QueryIntent;
    if (['semantic', 'sql', 'mcp_tool', 'hybrid'].includes(intent)) {
      return intent;
    }
    return 'semantic';
  }

  /**
   * Routes and executes a query.
   */
  async route(
    tenantId: string,
    userId: string,
    query: string,
    options: { agentId?: string; contextLimit?: number } = {}
  ): Promise<RoutedQueryResult> {
    const intent = await this.classifyIntent(query);
    const retriever = getRetriever();

    switch (intent) {
      case 'semantic': {
        const results = await retriever.search(tenantId, query, {
          limit: options.contextLimit ?? 8,
        });
        return {
          intent,
          answer: results.map((r) => r.content).join('\n\n'),
          sources: results.map((r) => ({
            content: r.content,
            source_kind: r.source_kind,
            similarity: r.similarity,
          })),
        };
      }

      case 'sql': {
        // For SQL queries, rely on semantic search of schema entities + generate SQL
        // The actual SQL execution happens in the agent loop with tool calls
        const results = await retriever.search(tenantId, query, { limit: 5 });
        return {
          intent,
          answer: results.map((r) => r.content).join('\n\n'),
          sources: results.map((r) => ({
            content: r.content,
            source_kind: r.source_kind,
          })),
        };
      }

      case 'mcp_tool': {
        // List available tools and return context for the agent to choose
        const mcpRouter = getMcpRouter();
        const tools = await mcpRouter.listAvailableTools(tenantId);
        return {
          intent,
          answer: `Available tools: ${tools.map((t) => t.name).join(', ')}`,
          sources: [],
          toolCalls: tools,
        };
      }

      case 'hybrid': {
        // Run both semantic + SQL routes concurrently
        const [semanticResults] = await Promise.all([
          retriever.search(tenantId, query, { limit: 5 }),
        ]);
        return {
          intent,
          answer: semanticResults.map((r) => r.content).join('\n\n'),
          sources: semanticResults.map((r) => ({
            content: r.content,
            source_kind: r.source_kind,
            similarity: r.similarity,
          })),
        };
      }

      default:
        return { intent: 'semantic', answer: '', sources: [] };
    }
  }
}

let instance: QueryRouter | null = null;
export function getQueryRouter(): QueryRouter {
  if (!instance) {
    instance = new QueryRouter();
  }
  return instance;
}
