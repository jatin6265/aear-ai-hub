import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

function sanitizeSql(sql: string) {
  const cleaned = sql
    .replace(/^```sql/gi, "")
    .replace(/^```/g, "")
    .replace(/```$/g, "")
    .replace(/;+/g, "")
    .trim();
  if (!/^(select|with)\b/i.test(cleaned)) {
    throw new Error("Generated SQL must be a read-only SELECT or WITH query");
  }
  if (/\b(insert|update|delete|drop|truncate|alter|create)\b/i.test(cleaned)) {
    throw new Error("Generated SQL contains non-read operations");
  }
  return cleaned;
}

async function generateSql(prompt: string, schemaContext: string) {
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey.trim()) throw new Error("OPENAI_API_KEY is not configured");

  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini",
      temperature: 0,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content:
            "You generate strictly read-only PostgreSQL queries. Use only SELECT/WITH. Never write, delete, alter, or call unsafe functions.",
        },
        {
          role: "user",
          content: `Tenant schema context:\n${schemaContext || "No schema entities available."}\n\nUser request:\n${prompt}\n\nReturn only SQL.`,
        },
      ],
    }),
  });

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  if (!response.ok) {
    throw new Error(`OpenAI SQL generation failed: ${JSON.stringify(payload)}`);
  }

  const sql = payload.choices?.[0]?.message?.content ?? "";
  return sanitizeSql(sql);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const prompt = String(body.prompt ?? body.query ?? "").trim();
  const connectionId = String(body.connectionId ?? body.connection_id ?? "").trim();
  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(Number(body.limit), 500)) : 100;

  if (!prompt) return errorResponse(400, "prompt is required");
  if (!connectionId) return errorResponse(400, "connectionId is required");

  const { data: entities, error: entitiesError } = await auth.supabase
    .from("connection_entities")
    .select("name, description, entity_group, sensitivity")
    .eq("connection_id", connectionId)
    .order("name", { ascending: true })
    .limit(80);

  if (entitiesError) return errorResponse(400, "Could not load schema context", entitiesError.message);

  const schemaContext = (entities ?? [])
    .map((row) => {
      const r = row as Record<string, unknown>;
      return `${String(r.name ?? "")}: ${String(r.description ?? "")} [group=${String(r.entity_group ?? "")}, sensitivity=${String(r.sensitivity ?? "")}]`;
    })
    .join("\n");

  try {
    const sql = await generateSql(prompt, schemaContext);
    const { data: execution, error: executionError } = await auth.supabase.rpc("execute_tenant_read_sql", {
      p_connection_id: connectionId,
      p_sql: sql,
      p_limit: limit,
    });

    if (executionError) {
      return errorResponse(400, "Generated SQL but execution failed", executionError.message);
    }

    const row = execution?.[0] as Record<string, unknown> | undefined;
    return jsonResponse(200, {
      ok: true,
      data: {
        sql,
        executionMs: Number(row?.execution_ms ?? 0),
        columns: row?.columns ?? [],
        rows: row?.rows ?? [],
        error: row?.error ?? null,
      },
      error: null,
    });
  } catch (error) {
    return errorResponse(400, "Could not generate NL SQL", error instanceof Error ? error.message : String(error));
  }
});
