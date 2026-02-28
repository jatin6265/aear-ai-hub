import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Manages the Supabase client connection for the worker.
 * Handles service-role authentication and connectivity validation.
 */
export class SupabaseService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: SupabaseClient<any>;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('Supabase URL and Service Role Key are required.');
    }
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getClient(): SupabaseClient<any> {
    return this.client;
  }

  /**
   * Performs a health check on the Supabase connection.
   */
  async validateConnectivity(): Promise<void> {
    const { error } = await this.client.from('tenants').select('count', { count: 'exact', head: true });
    if (error) {
      throw new Error(`Supabase connectivity check failed: ${error.message}`);
    }
  }

  async rpc<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<{ data: T | null; error: Error | null }> {
    return await this.client.rpc(name as never, params) as { data: T | null; error: Error | null };
  }
}

let instance: SupabaseService | null = null;

export function getSupabaseService(): SupabaseService {
  if (!instance) {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;
    
    if (!url || !key) {
      throw new Error('Supabase environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are missing.');
    }
    
    instance = new SupabaseService(url, key);
  }
  return instance;
}
