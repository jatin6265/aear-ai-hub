import { getSupabaseService } from '../lib/supabase';
import { sanitizeName } from '../lib/utils';

export class AutoToolGenerator {
  /**
   * Generates tool definitions for a specific connection based on its discovered schema.
   */
  async generateToolsForConnection(connectionId: string): Promise<void> {
    const supabase = getSupabaseService();

    // 1. Fetch connection and entities
    const { data: connection } = await supabase.getClient()
      .from('api_connections')
      .select('*')
      .eq('id', connectionId)
      .single();

    if (!connection) throw new Error('Connection not found');

    const { data: entities } = await supabase.getClient()
      .from('schema_entities')
      .select('*')
      .eq('connection_id', connectionId);

    if (!entities || entities.length === 0) return;

    // 2. Map entities to tool definitions
    for (const entity of entities) {
      const toolCode = sanitizeName(`${connection.name}_get_${entity.name}`);
      
      const toolDefinition = {
        tenant_id: connection.tenant_id,
        code: toolCode,
        display_name: `Get ${entity.name}`,
        description: `Fetch records from ${entity.name} in ${connection.name}.`,
        category: 'data_source',
        handler_key: 'sql_query_handler', // Default for DB connections
        input_schema: {
          type: 'object',
          properties: {
            filters: { type: 'object', description: 'Query filters' },
            limit: { type: 'number', default: 10 }
          }
        },
        risk_level: 'low',
        is_write_action: false
      };

      // 3. Upsert into tool registry
      await supabase.getClient()
        .from('tool_registry')
        .upsert(toolDefinition, { onConflict: 'tenant_id,code' });
    }
  }
}

let instance: AutoToolGenerator | null = null;
export function getAutoToolGenerator(): AutoToolGenerator {
  if (!instance) {
    instance = new AutoToolGenerator();
  }
  return instance;
}
