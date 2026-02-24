import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation = "get_payload" | "save_configuration";

type RequestBody = {
  operation?: Operation;
  bulkUpdateLimit?: string | number;
  simulationModeEnabled?: boolean;
  businessHoursLockEnabled?: boolean;
  businessStart?: string;
  businessEnd?: string;
  businessTimezone?: string;
  financialMutationLimit?: string | number;
  financialCurrency?: string;
  newUserRestrictionDays?: string | number;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function toNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(clean(value));
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function isRpcFallbackError(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return (
    code === "PGRST202" ||
    (code === "42702" && message.includes("tenant_id") && message.includes("ambiguous")) ||
    message.includes("could not find the function")
  );
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildGuardrailsFallbackPayload(supabase: any, userId: string, reason: string) {
  const defaultPayload = {
    profileRole: "member",
    isAdmin: false,
    hardGuardrails: [
      {
        code: "hard_mass_delete_without_where",
        title: "Mass DELETE without WHERE clause",
        description: "Always blocked",
        enabled: true,
        badge: "Cannot be disabled",
      },
      {
        code: "hard_drop_or_truncate",
        title: "DROP TABLE / TRUNCATE",
        description: "Always blocked",
        enabled: true,
        badge: "Cannot be disabled",
      },
      {
        code: "hard_financial_without_accountable",
        title: "Financial ledger manipulation without Accountable approval",
        description: "Always blocked",
        enabled: true,
        badge: "Cannot be disabled",
      },
      {
        code: "hard_prompt_injection_filter",
        title: "Prompt injection patterns",
        description: "Always filtered",
        enabled: true,
        badge: "Cannot be disabled",
      },
      {
        code: "hard_unknown_tool_reject",
        title: "Unknown tool execution",
        description: "Always rejected",
        enabled: true,
        badge: "Cannot be disabled",
      },
    ],
    configuration: {
      bulkUpdateLimit: { enabled: true, threshold: 100, unlimited: false },
      simulationMode: { enabled: true },
      businessHoursLock: { enabled: true, start: "09:00", end: "18:00", timezone: "UTC" },
      financialMutationLimit: { enabled: true, amount: 10000, currency: "USD" },
      newUserRestriction: { enabled: true, days: 7 },
    },
    updatedAt: null as string | null,
    fallback: {
      used: true,
      reason,
    },
  };

  const profileRes = await supabase
    .from("profiles")
    .select("tenant_id, role")
    .eq("id", userId)
    .maybeSingle();
  const tenantId = clean(profileRes.data?.tenant_id);
  const role = clean(profileRes.data?.role).toLowerCase() || "member";
  defaultPayload.profileRole = role;
  defaultPayload.isAdmin = ["owner", "admin", "manager"].includes(role);

  if (!tenantId) return defaultPayload;

  const guardrailsRes = await supabase
    .from("guardrails")
    .select("code,name,description,enabled,config,updated_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  const rows = asArray(guardrailsRes.data) as Array<Record<string, unknown>>;
  if (rows.length === 0) return defaultPayload;

  const hardRows = rows.filter((row) => {
    const code = clean(row.code);
    const section = clean((row.config as Record<string, unknown> | null)?.section);
    return code.startsWith("hard_") || section === "hard";
  });

  if (hardRows.length > 0) {
    defaultPayload.hardGuardrails = hardRows.map((row) => ({
      code: clean(row.code),
      title: clean(row.name) || clean(row.code),
      description: clean(row.description) || "Always active",
      enabled: true,
      badge: clean((row.config as Record<string, unknown> | null)?.cannotDisableLabel) || "Cannot be disabled",
    }));
  }

  const findConfig = (code: string) => rows.find((row) => clean(row.code) === code);
  const bulk = findConfig("cfg_bulk_update_limit");
  const simulation = findConfig("cfg_simulation_mode");
  const business = findConfig("cfg_business_hours_lock");
  const financial = findConfig("cfg_financial_mutation_limit");
  const newUser = findConfig("cfg_new_user_restriction");

  if (bulk) {
    const cfg = (bulk.config ?? {}) as Record<string, unknown>;
    const threshold = toNumber(cfg.threshold, 100);
    defaultPayload.configuration.bulkUpdateLimit = {
      enabled: bulk.enabled !== false,
      threshold: Math.max(10, Math.round(threshold)),
      unlimited: cfg.unlimited === true || bulk.enabled === false,
    };
  }
  if (simulation) {
    defaultPayload.configuration.simulationMode = { enabled: simulation.enabled !== false };
  }
  if (business) {
    const cfg = (business.config ?? {}) as Record<string, unknown>;
    defaultPayload.configuration.businessHoursLock = {
      enabled: business.enabled !== false,
      start: clean(cfg.start) || "09:00",
      end: clean(cfg.end) || "18:00",
      timezone: clean(cfg.timezone) || "UTC",
    };
  }
  if (financial) {
    const cfg = (financial.config ?? {}) as Record<string, unknown>;
    defaultPayload.configuration.financialMutationLimit = {
      enabled: financial.enabled !== false,
      amount: toNumber(cfg.amount, 10000),
      currency: clean(cfg.currency || "USD").toUpperCase() || "USD",
    };
  }
  if (newUser) {
    const cfg = (newUser.config ?? {}) as Record<string, unknown>;
    defaultPayload.configuration.newUserRestriction = {
      enabled: newUser.enabled !== false,
      days: Math.max(0, Math.min(365, Math.round(toNumber(cfg.days, 7)))),
    };
  }

  const latestUpdated = rows
    .map((row) => clean(row.updated_at))
    .filter((value) => value.length > 0)
    .sort()
    .at(-1);
  defaultPayload.updatedAt = latestUpdated || null;

  return defaultPayload;
}

async function getPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
) {
  const { data, error } = await supabase.rpc("get_guardrails_configuration_payload");
  if (error) {
    const reason = isRpcFallbackError(error)
      ? `Fallback payload used: ${error.message ?? "guardrails payload RPC unavailable"}`
      : `Fallback payload used after RPC failure: ${error.message ?? "guardrails payload RPC failed"}`;
    return buildGuardrailsFallbackPayload(supabase, userId, reason);
  }
  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const operation = clean(body.operation || "get_payload").toLowerCase() as Operation;

  try {
    if (operation === "save_configuration") {
      const bulkLimitRaw = clean(body.bulkUpdateLimit);
      const bulkUpdateLimit = bulkLimitRaw.length > 0 ? bulkLimitRaw : "100";

      const simulationModeEnabled = body.simulationModeEnabled !== false;
      const businessHoursLockEnabled = body.businessHoursLockEnabled !== false;
      const businessStart = clean(body.businessStart || "09:00") || "09:00";
      const businessEnd = clean(body.businessEnd || "18:00") || "18:00";
      const businessTimezone = clean(body.businessTimezone || "UTC") || "UTC";

      const financialMutationLimit = toNumber(body.financialMutationLimit, 10000);
      const financialCurrency = clean(body.financialCurrency || "USD") || "USD";
      const newUserRestrictionDays = Math.round(toNumber(body.newUserRestrictionDays, 7));

      const { data, error } = await auth.supabase.rpc("save_guardrails_configuration", {
        p_bulk_update_limit: bulkUpdateLimit,
        p_simulation_mode_enabled: simulationModeEnabled,
        p_business_hours_lock_enabled: businessHoursLockEnabled,
        p_business_start: businessStart,
        p_business_end: businessEnd,
        p_business_timezone: businessTimezone,
        p_financial_limit: financialMutationLimit,
        p_financial_currency: financialCurrency,
        p_new_user_days: newUserRestrictionDays,
      });

      if (error) return errorResponse(400, "Failed to save guardrails configuration", error.message);

      return jsonResponse(200, {
        ok: true,
        operation,
        payload: data ?? null,
      });
    }

    if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    const payload = await getPayload(auth.supabase, auth.user.id);
    return jsonResponse(200, {
      ok: true,
      operation,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected guardrails configuration error", error instanceof Error ? error.message : null);
  }
});
