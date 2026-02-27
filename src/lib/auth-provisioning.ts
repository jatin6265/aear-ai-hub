import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const MAX_TENANT_SLUG_ATTEMPTS = 5;
const DEFAULT_DB_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.max(1, Math.floor(timeoutMs / 1000))}s.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
}

function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length);
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}

export function deriveCompanyNameFromEmail(email?: string | null) {
  if (!email) return "New Workspace";

  const domain = email.split("@")[1] ?? "";
  const label = domain.split(".")[0] ?? "";
  if (!label) return "New Workspace";

  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function createTenant(companyName: string) {
  const baseSlug = slugify(companyName);

  for (let attempt = 0; attempt < MAX_TENANT_SLUG_ATTEMPTS; attempt += 1) {
    const slug = `${baseSlug}-${randomSuffix(attempt === 0 ? 4 : 6)}`;
    const { data, error } = await withTimeout(
      supabase
        .from("tenants")
        .insert({
          name: companyName,
          slug,
        })
        .select("id")
        .single(),
      DEFAULT_DB_TIMEOUT_MS,
      "Tenant creation",
    );

    if (!error) return data.id;
    if (error.code !== "23505") throw error;
  }

  throw new Error("Unable to create tenant. Please try again.");
}

type EnsureUserWorkspaceOptions = {
  fullName?: string | null;
  companyName?: string | null;
  termsAccepted?: boolean;
};

function isMissingProvisioningFunction(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  return (error.message ?? "").toLowerCase().includes("could not find the function");
}

function isRecoverableProvisioningRpcError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  if (isMissingProvisioningFunction(error)) return true;

  const code = String(error.code ?? "").trim();
  const message = String(error.message ?? "").toLowerCase();
  if (code === "42702") return true;
  if (message.includes("column reference") && message.includes("ambiguous")) return true;
  if (message.includes("provision_user_workspace") && message.includes("does not exist")) return true;
  return false;
}

export async function ensureUserWorkspace(user: User, options?: EnsureUserWorkspaceOptions) {
  const fullName =
    options?.fullName ??
    (typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null);
  const companyName =
    options?.companyName ??
    (typeof user.user_metadata?.company_name === "string" ? user.user_metadata.company_name : null) ??
    deriveCompanyNameFromEmail(user.email);
  const termsAccepted = Boolean(options?.termsAccepted);

  const rpcResponse = await withTimeout(
    supabase.rpc("provision_user_workspace", {
      p_company_name: companyName,
      p_full_name: fullName,
      p_terms_accepted: termsAccepted,
    }),
    DEFAULT_DB_TIMEOUT_MS,
    "Workspace provisioning RPC",
  );

  if (!rpcResponse.error && rpcResponse.data?.[0]) {
    return {
      role: rpcResponse.data[0].role,
      tenantId: rpcResponse.data[0].tenant_id,
    };
  }

  if (rpcResponse.error && !isRecoverableProvisioningRpcError(rpcResponse.error)) {
    throw rpcResponse.error;
  }

  const { data: existingProfile, error: profileError } = await withTimeout(
    supabase
      .from("profiles")
      .select("id, tenant_id, role, full_name, terms_accepted_at")
      .eq("id", user.id)
      .maybeSingle(),
    DEFAULT_DB_TIMEOUT_MS,
    "Profile lookup",
  );

  if (profileError) throw profileError;

  let tenantId = existingProfile?.tenant_id ?? null;
  if (!tenantId) {
    tenantId = await createTenant(companyName);
  }

  const { data: profile, error: upsertError } = await withTimeout(
    supabase
      .from("profiles")
      .upsert(
        {
          id: user.id,
          full_name: fullName ?? existingProfile?.full_name ?? null,
          role: existingProfile?.role ?? "owner",
          tenant_id: tenantId,
          terms_accepted_at:
            existingProfile?.terms_accepted_at ?? (termsAccepted ? new Date().toISOString() : null),
        },
        { onConflict: "id" },
      )
      .select("role, tenant_id")
      .single(),
    DEFAULT_DB_TIMEOUT_MS,
    "Profile upsert",
  );

  if (upsertError) throw upsertError;

  return {
    role: profile.role,
    tenantId: profile.tenant_id as string,
  };
}

export async function tenantHasConnections(tenantId: string) {
  const { count, error } = await withTimeout(
    supabase
      .from("api_connections")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId),
    DEFAULT_DB_TIMEOUT_MS,
    "Connection count",
  );

  if (error) throw error;

  return (count ?? 0) > 0;
}

function isMissingOnboardingColumns(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const message = String(error.message ?? "").toLowerCase();
  return message.includes("onboarding_step") || message.includes("onboarding_completed_at");
}

export async function tenantNeedsOnboarding(tenantId: string) {
  const onboardingQuery = await withTimeout(
    supabase
      .from("tenants")
      .select("status,onboarding_step,onboarding_completed_at")
      .eq("id", tenantId)
      .maybeSingle(),
    DEFAULT_DB_TIMEOUT_MS,
    "Tenant onboarding lookup",
  );

  if (!onboardingQuery.error && onboardingQuery.data) {
    const status = String(onboardingQuery.data.status ?? "").trim().toLowerCase();
    const step = Number(onboardingQuery.data.onboarding_step ?? 1);
    const completedAt = onboardingQuery.data.onboarding_completed_at;
    const completed =
      status === "active" ||
      (Number.isFinite(step) && step >= 4) ||
      Boolean(completedAt);
    return !completed;
  }

  if (onboardingQuery.error && !isMissingOnboardingColumns(onboardingQuery.error)) {
    throw onboardingQuery.error;
  }

  const statusQuery = await withTimeout(
    supabase
      .from("tenants")
      .select("status")
      .eq("id", tenantId)
      .maybeSingle(),
    DEFAULT_DB_TIMEOUT_MS,
    "Tenant status lookup",
  );

  if (statusQuery.error) throw statusQuery.error;

  const status = String(statusQuery.data?.status ?? "").trim().toLowerCase();
  return status !== "active";
}
