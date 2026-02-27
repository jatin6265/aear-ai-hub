#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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

loadDotEnvFile(".env");
const DEFAULT_FUNCTION_TIMEOUT_MS = Number(process.env.E2E_FUNCTION_TIMEOUT_MS || 20_000);
const DEFAULT_SMOKE_TIMEOUT_MS = Number(process.env.E2E_SMOKE_TIMEOUT_MS || 180_000);

const projectRef = process.env.VITE_SUPABASE_PROJECT_ID || process.env.PROJECT_ID || "";
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
  console.error("Missing required env: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY), SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const rootDir = process.cwd();

function walkFiles(dir, fileList = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, fileList);
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) fileList.push(fullPath);
  }
  return fileList;
}

function extractInvokedFunctions() {
  const sourceFiles = walkFiles(path.join(rootDir, "src"));
  const invokePattern = /(?:invokeEdge|functions\.invoke)\(\s*["'`]([a-z0-9-]+)["'`]/g;
  const usage = new Map();

  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    let match;
    while ((match = invokePattern.exec(content))) {
      const fn = match[1];
      if (!usage.has(fn)) usage.set(fn, new Set());
      usage.get(fn).add(path.relative(rootDir, file));
    }
  }
  return usage;
}

function readManifestFunctions() {
  const manifestPath = path.join(rootDir, "supabase/functions/deploy-manifest.json");
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return new Set(Array.isArray(parsed.functions) ? parsed.functions : []);
}

function listDeployedFunctions() {
  if (!projectRef) return new Set();
  const output = execSync(`supabase functions list --project-ref ${projectRef}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deployed = new Set();
  for (const line of output.split("\n")) {
    if (!line.includes("|")) continue;
    const cols = line.split("|").map((part) => part.trim());
    if (cols.length < 4) continue;
    const name = cols[1];
    if (!name || name.toLowerCase() === "name" || /^-+$/.test(name)) continue;
    if (/^[a-z0-9-]+$/.test(name)) deployed.add(name);
  }
  return deployed;
}

function authzExpected(errorMessage, fallback) {
  const value = `${errorMessage || ""} ${fallback || ""}`.toLowerCase();
  return (
    value.includes("forbidden") ||
    value.includes("admin") ||
    value.includes("superadmin") ||
    value.includes("platform admin access required")
  );
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.max(1, Math.floor(timeoutMs / 1000))}s`)), timeoutMs);
    }),
  ]);
}

async function runSmokeChecks() {
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const app = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const email = `smoke-e2e-${Date.now()}@example.com`;
  const password = "Sm0kePass!234";
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Smoke E2E", company_name: "Smoke Co" },
  });
  if (created.error || !created.data.user) {
    throw new Error(`Could not create smoke user: ${created.error?.message || "unknown error"}`);
  }
  const userId = created.data.user.id;

  const cleanup = async () => {
    await admin.auth.admin.deleteUser(userId);
  };

  try {
    const signedIn = await app.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error(`Could not sign in smoke user: ${signedIn.error.message}`);

    const provision = await app.rpc("provision_user_workspace", {
      p_company_name: "Smoke Co",
      p_full_name: "Smoke E2E",
      p_terms_accepted: true,
    });
    if (provision.error) throw new Error(`Could not provision smoke workspace: ${provision.error.message}`);

    const invoke = async (fn, body = {}) => {
      const { data, error } = await withTimeout(
        app.functions.invoke(fn, { body }),
        DEFAULT_FUNCTION_TIMEOUT_MS,
        `Function '${fn}'`,
      );
      let errorBody = "";
      if (error?.context && typeof error.context === "object" && typeof error.context.clone === "function") {
        try {
          errorBody = await error.context.clone().text();
        } catch {
          errorBody = "";
        }
      }
      return { fn, data, error, errorBody };
    };

    const results = await withTimeout(
      (async () => {
        const rows = [];
        rows.push(await invoke("onboarding-company-setup", { name: "Smoke Co", region: "us-east", industry: "Technology", companySize: "1-10", primaryUseCase: "Operations AI" }));
        rows.push(await invoke("test-data-connection", { connectionType: "custom_rest", payload: { baseUrl: "https://example.com" } }));
        const createConnection = await invoke("create-data-connection", {
          name: "Smoke REST",
          type: "custom_rest",
          baseUrl: "https://example.com",
          authType: "none",
          config: {},
        });
        rows.push(createConnection);

        const connectionId = String(createConnection.data?.connectionId || "");
        if (connectionId) {
          rows.push(await invoke("run-schema-discovery", { connectionId, triggerReason: "smoke_test" }));
          rows.push(await invoke("connector-sync-dispatch", { connectionId, triggerReason: "smoke_test" }));
        }

        rows.push(await invoke("launch-workspace", { raciRules: [] }));
        rows.push(await invoke("agents-dashboard", {}));
        rows.push(await invoke("chat-execute", { prompt: "how many connections do i have?" }));
        rows.push(await invoke("raci-editor", { action: "list" }));
        rows.push(await invoke("raci-role-management", { action: "list" }));
        rows.push(await invoke("guardrails-risk-dashboard", { section: "overview" }));
        rows.push(await invoke("team-management", { operation: "get_payload" }));
        rows.push(await invoke("knowledge-reindex-dispatch", {}));
        rows.push(await invoke("notification-settings", { operation: "get_payload" }));
        rows.push(await invoke("api-keys-management", { operation: "get_payload" }));
        rows.push(await invoke("tenant-billing-dashboard", {}));
        rows.push(await invoke("billing-invoices", { operation: "get_payload" }));
        rows.push(await invoke("insights-feed", { operation: "list" }));
        rows.push(await invoke("widget-integration", { operation: "get_payload" }));
        rows.push(await invoke("marketplace-directory", { operation: "get_payload" }));
        rows.push(await invoke("public-pricing", { interval: "monthly" }));
        rows.push(await invoke("admin-console", { operation: "get_payload" }));
        rows.push(await invoke("platform-admin-tenants", { operation: "get_payload" }));
        rows.push(await invoke("platform-admin-revenue", { operation: "get_payload" }));
        rows.push(await invoke("platform-admin-infrastructure", { operation: "get_payload" }));
        rows.push(await invoke("send-team-invites", { invites: [{ email: `invite-${Date.now()}@example.com`, role: "member" }] }));
        return rows;
      })(),
      DEFAULT_SMOKE_TIMEOUT_MS,
      "E2E smoke checks",
    );

    let hardFailCount = 0;
    let warnCount = 0;

    for (const row of results) {
      if (!row.error) {
        console.log(`PASS ${row.fn}`);
        continue;
      }

      const msg = row.error.message || "Unknown function error";
      const detail = `${typeof row.error.context === "object" ? JSON.stringify(row.error.context) : ""} ${row.errorBody || ""}`;

      if (row.fn.startsWith("platform-admin") || row.fn === "admin-console") {
        if (authzExpected(msg, detail)) {
          console.log(`PASS ${row.fn} (authz enforced)`);
          continue;
        }
      }

      if (row.fn === "send-team-invites") {
        console.log(`WARN ${row.fn}: ${msg}`);
        warnCount += 1;
        continue;
      }

      console.log(`FAIL ${row.fn}: ${msg}`);
      hardFailCount += 1;
    }

    const chatRow = results.find((row) => row.fn === "chat-execute");
    const chatAnswer = String(chatRow?.data?.assistant || "");
    if (!chatAnswer.toLowerCase().includes("connection")) {
      console.log("FAIL chat-execute: workspace-context response missing expected connection summary");
      hardFailCount += 1;
    } else {
      console.log("PASS chat-execute workspace context");
    }

    return { hardFailCount, warnCount };
  } finally {
    await cleanup();
  }
}

async function main() {
  const invokeUsage = extractInvokedFunctions();
  const manifestFunctions = readManifestFunctions();
  const deployedFunctions = listDeployedFunctions();

  const invokedNames = [...invokeUsage.keys()].sort();
  const missingInManifest = invokedNames.filter((name) => !manifestFunctions.has(name));
  const missingInDeploy = invokedNames.filter((name) => !deployedFunctions.has(name));

  console.log(`Frontend invokes ${invokedNames.length} edge functions.`);
  if (missingInManifest.length) {
    console.log(`Missing from deploy manifest: ${missingInManifest.join(", ")}`);
  } else {
    console.log("PASS manifest coverage for frontend-invoked functions");
  }

  if (missingInDeploy.length) {
    console.log(`Missing from deployed project: ${missingInDeploy.join(", ")}`);
  } else {
    console.log("PASS deployed coverage for frontend-invoked functions");
  }

  const smoke = await runSmokeChecks();
  const failed = missingInManifest.length + missingInDeploy.length + smoke.hardFailCount;
  console.log(`Smoke summary: hard_fail=${failed}, warn=${smoke.warnCount}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
