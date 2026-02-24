import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeYear(value: unknown) {
  const parsed = Number(value);
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isFinite(parsed)) return currentYear;
  return Math.max(2020, Math.min(Math.trunc(parsed), currentYear + 1));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation = "";
  let year = new Date().getUTCFullYear();
  let invoiceId = "";

  try {
    const body = (await req.json()) as {
      operation?: string;
      year?: number;
      invoiceId?: string;
    };
    operation = clean(body?.operation).toLowerCase();
    year = normalizeYear(body?.year);
    invoiceId = clean(body?.invoiceId);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!operation) return errorResponse(400, "operation is required");

  if (operation === "get_payload") {
    const { data, error } = await auth.supabase.rpc("get_billing_invoice_history", {
      p_year: year,
    });
    if (error) return errorResponse(400, "Could not load invoice history", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  if (operation === "get_invoice_detail") {
    if (!invoiceId) return errorResponse(400, "invoiceId is required");
    const { data, error } = await auth.supabase.rpc("get_billing_invoice_detail", {
      p_invoice_id: invoiceId,
    });
    if (error) return errorResponse(400, "Could not load invoice detail", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  if (operation === "retry_payment") {
    if (!invoiceId) return errorResponse(400, "invoiceId is required");
    const { data, error } = await auth.supabase.rpc("request_invoice_payment_retry", {
      p_invoice_id: invoiceId,
    });
    if (error) return errorResponse(400, "Could not request payment retry", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  return errorResponse(400, "Unknown operation");
});

