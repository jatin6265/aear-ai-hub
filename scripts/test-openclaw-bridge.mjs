#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

function loadDotEnvFile(fileName = ".env") {
  const filePath = path.join(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function buildWorkerDistIfMissing() {
  const distEngine = path.join(process.cwd(), "worker/dist/services/agent-core/openclawRpcEngine.js");
  const distWrapper = path.join(process.cwd(), "worker/dist/services/governance/wrapper.js");
  if (fs.existsSync(distEngine) && fs.existsSync(distWrapper)) return;
  console.log("worker/dist missing, building worker TypeScript...");
  execSync("npm --prefix worker run build", { stdio: "inherit" });
}

async function resolveTenantAndUser(admin, args) {
  const tenantIdFromArg = String(args.tenant || process.env.SMOKE_TENANT_ID || "").trim();
  const userIdFromArg = String(args.user || process.env.SMOKE_USER_ID || "").trim();

  if (tenantIdFromArg && userIdFromArg) {
    return { tenantId: tenantIdFromArg, userId: userIdFromArg };
  }

  if (tenantIdFromArg) {
    const { data, error } = await admin
      .from("profiles")
      .select("id, tenant_id")
      .eq("tenant_id", tenantIdFromArg)
      .limit(1)
      .maybeSingle();
    if (error || !data?.id) {
      throw new Error(`Could not resolve profile for tenant ${tenantIdFromArg}: ${error?.message || "none found"}`);
    }
    return { tenantId: tenantIdFromArg, userId: String(data.id) };
  }

  if (userIdFromArg) {
    const { data, error } = await admin
      .from("profiles")
      .select("id, tenant_id")
      .eq("id", userIdFromArg)
      .maybeSingle();
    if (error || !data?.tenant_id) {
      throw new Error(`Could not resolve tenant for user ${userIdFromArg}: ${error?.message || "none found"}`);
    }
    return { tenantId: String(data.tenant_id), userId: userIdFromArg };
  }

  const { data, error } = await admin
    .from("profiles")
    .select("id, tenant_id")
    .not("tenant_id", "is", null)
    .limit(1)
    .maybeSingle();

  if (error || !data?.id || !data?.tenant_id) {
    throw new Error(
      "Could not auto-resolve tenant/user from profiles. Set --tenant/--user or SMOKE_TENANT_ID/SMOKE_USER_ID."
    );
  }

  return { tenantId: String(data.tenant_id), userId: String(data.id) };
}

async function main() {
  loadDotEnvFile(".env");
  const args = parseArgs(process.argv.slice(2));

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  buildWorkerDistIfMissing();

  const require = createRequire(import.meta.url);
  const { OpenClawRpcEngine } = require("../worker/dist/services/agent-core/openclawRpcEngine.js");
  const { governanceWrappedExecute } = require("../worker/dist/services/governance/wrapper.js");

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { tenantId, userId } = await resolveTenantAndUser(admin, args);
  const runId = `smoke-openclaw-${Date.now()}`;
  const toolName = "smoke_governed_echo";

  const engine = new OpenClawRpcEngine();
  const model = String(process.env.OPENAI_MODEL || "gpt-4.1-mini");

  console.log(`Running OpenClaw bridge smoke with tenant=${tenantId} user=${userId} model=${model}`);

  const result = await engine.run({
    model,
    input:
      'Call tool "smoke_governed_echo" once with {"message":"hello from smoke"} and then return final response with the tool output.',
    systemPrompt: [
      "You are a runtime smoke tester.",
      `You MUST call "${toolName}" exactly once before final response.`,
      "Never skip the tool call.",
    ].join("\n"),
    tools: [
      {
        name: toolName,
        description: "Governed smoke test tool. Returns deterministic payload.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (params) =>
          await governanceWrappedExecute({
            tenantId,
            userId,
            toolName,
            resource: "smoke.bridge",
            action: "read",
            params,
            riskLevel: "low",
            requiresWrite: false,
            context: {
              runId,
              sessionId: "smoke-session",
              agentId: "smoke-agent",
            },
            execute: async () => ({
              ok: true,
              echoed: asRecord(params),
              at: new Date().toISOString(),
            }),
          }),
      },
    ],
    maxTurns: 4,
  });

  if (!Array.isArray(result.toolRuns) || result.toolRuns.length === 0) {
    throw new Error("OpenClaw returned no tool calls. Bridge did not execute governed tool.");
  }

  const smokeRun = result.toolRuns.find((row) => row.toolName === toolName) || result.toolRuns[0];
  const status =
    smokeRun.ok === true
      ? "success"
      : /approval|governance|denied|permission/i.test(String(smokeRun.error || ""))
      ? "governed_block_or_approval"
      : "failed";

  if (status === "failed") {
    throw new Error(`Governed tool call failed unexpectedly: ${smokeRun.error || "unknown error"}`);
  }

  const { data: recentLogs, error: logError } = await admin
    .from("audit_logs")
    .select("id, action, status, risk_level, created_at, details")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(25);

  if (logError) {
    throw new Error(`Could not query audit_logs: ${logError.message}`);
  }

  const matchedAudit = (recentLogs || []).find((row) => {
    const details = asRecord(row.details);
    const payload = asRecord(details.payload);
    const context = asRecord(payload.context);
    return String(context.runId || "") === runId;
  });

  if (!matchedAudit) {
    throw new Error("No matching audit log row found for smoke run context.");
  }

  console.log("Smoke OK");
  console.log(
    JSON.stringify(
      {
        engine: "openclaw-rpc",
        tenantId,
        userId,
        runId,
        toolStatus: status,
        toolRun: smokeRun,
        auditLog: {
          id: matchedAudit.id,
          action: matchedAudit.action,
          status: matchedAudit.status,
          risk_level: matchedAudit.risk_level,
          created_at: matchedAudit.created_at,
        },
        output: result.output,
        usage: result.usage,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`Smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
