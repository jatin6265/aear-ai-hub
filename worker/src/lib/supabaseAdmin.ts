import { getSupabaseService } from "./supabase";

/**
 * Compatibility wrapper expected by the Phase 1 build plan.
 * Canonical implementation remains in ./supabase.
 */
export function getSupabaseAdminClient() {
  return getSupabaseService().getClient();
}

export { getSupabaseService } from "./supabase";
