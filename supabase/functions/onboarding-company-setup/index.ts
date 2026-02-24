import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getServiceClient } from "../_shared/service.ts";

type RequestBody = {
  name?: string;
  region?: string;
  industry?: string;
  companySize?: string;
  primaryUseCase?: string;
  logoUrl?: string | null;
};

function cleanText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isMissingColumnError(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("column") && lower.includes("does not exist");
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function randomSuffix(length = 6) {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  const service = getServiceClient();
  if (!service.ok) return service.response;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const name = cleanText(body.name);
  const region = cleanText(body.region);
  const industry = cleanText(body.industry);
  const companySize = cleanText(body.companySize);
  const primaryUseCase = cleanText(body.primaryUseCase);
  const logoUrl = cleanText(body.logoUrl);

  if (!name || !region) {
    return errorResponse(400, "Company name and region are required");
  }

  const { data: profile, error: profileError } = await service.supabase
    .from("profiles")
    .select("id, tenant_id, role")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (profileError) return errorResponse(400, "Could not resolve workspace profile", profileError.message);

  const fullName = cleanText((auth.user.user_metadata as Record<string, unknown> | null)?.full_name);

  let tenantId = typeof profile?.tenant_id === "string" ? profile.tenant_id : null;
  if (!tenantId) {
    const baseSlug = slugify(name);
    let createdTenantId: string | null = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = `${baseSlug}-${randomSuffix(attempt < 3 ? 4 : 6)}`;
      const insertRes = await service.supabase.from("tenants").insert({ name, slug }).select("id").single();
      if (!insertRes.error) {
        createdTenantId = String(insertRes.data.id);
        break;
      }

      if (insertRes.error.code !== "23505") {
        return errorResponse(400, "Could not provision workspace tenant", insertRes.error.message);
      }
    }

    if (!createdTenantId) {
      return errorResponse(400, "Could not provision workspace tenant", "Unable to create workspace tenant");
    }

    tenantId = createdTenantId;
  }

  const role = cleanText(profile?.role) ?? "owner";
  const profileUpsert = await service.supabase.from("profiles").upsert(
    {
      id: auth.user.id,
      full_name: fullName,
      role,
      tenant_id: tenantId,
    },
    { onConflict: "id" },
  );
  if (profileUpsert.error) return errorResponse(400, "Could not update workspace profile", profileUpsert.error.message);

  const subscriptionUpsert = await service.supabase.from("subscriptions").upsert(
    {
      tenant_id: tenantId,
      plan: "starter",
      status: "trial",
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "tenant_id" },
  );
  if (subscriptionUpsert.error) {
    return errorResponse(400, "Could not initialize subscription", subscriptionUpsert.error.message);
  }

  const fullPayload = {
    name,
    region,
    industry,
    company_size: companySize,
    primary_use_case: primaryUseCase,
    logo_url: logoUrl,
    onboarding_step: 2,
  };

  let updateResult = await service.supabase
    .from("tenants")
    .update(fullPayload)
    .eq("id", tenantId)
    .select("id,name,region,industry,company_size,primary_use_case,logo_url,onboarding_step")
    .maybeSingle();

  if (updateResult.error && isMissingColumnError(updateResult.error.message)) {
    updateResult = await service.supabase
      .from("tenants")
      .update({
        name,
        region,
      })
      .eq("id", tenantId)
      .select("id,name,region,onboarding_step")
      .maybeSingle();
  }

  if (updateResult.error) return errorResponse(400, "Could not save company setup", updateResult.error.message);
  if (!updateResult.data) return errorResponse(400, "No tenant row was updated");

  await service.supabase.from("audit_logs").insert({
    tenant_id: tenantId,
    user_id: auth.user.id,
    action: "tenant.company_setup.update",
    resource: "tenant",
    status: "success",
    details: {
      region,
      industry,
      companySize,
      primaryUseCase,
    },
  });

  return jsonResponse(200, {
    ok: true,
    tenantId,
    tenant: updateResult.data,
  });
});
