import { BaseConnector } from './base';
import { getSupabaseService } from '../lib/supabase';
import { getEmbedder } from '../pipeline/embedder';

/**
 * Slack connector: processes Slack events and indexes messages.
 *
 * Supports: channels:read, channels:history, groups:read, im:read
 * Auth: OAuth 2.0
 */
export class SlackConnector extends BaseConnector {
  private get token(): string {
    return String(this.config.access_token || this.config.bot_token || '');
  }

  async validateConnection(): Promise<boolean> {
    try {
      const response = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await response.json() as { ok: boolean; error?: string };
      return data.ok === true;
    } catch {
      return false;
    }
  }

  async discoverSchema(): Promise<{
    entities: unknown[];
    relationships: unknown[];
    schemaTablesCount: number;
    schemaEntitiesCount: number;
  }> {
    const channels = await this.listChannels();
    const entities = channels.map((ch) => ({
      name: ch.name,
      sourceKind: 'slack_channel',
      entityGroup: 'communication',
      rowCount: ch.num_members ?? 0,
      riskLevel: 'low' as const,
      sensitivity: ch.is_private ? ['private'] : [],
      description: `Slack channel #${ch.name}`,
      columns: [
        { name: 'message', dataType: 'text', nullable: false, sensitivity: [] },
        { name: 'user', dataType: 'text', nullable: false, sensitivity: ['pii'] },
        { name: 'ts', dataType: 'timestamp', nullable: false, sensitivity: [] },
      ],
    }));

    return {
      entities,
      relationships: [],
      schemaTablesCount: entities.length,
      schemaEntitiesCount: entities.length,
    };
  }

  async syncEntity(channelId: string): Promise<{
    rowsProcessed: number;
    status: 'success' | 'error' | 'partial';
    error?: string;
  }> {
    const embedder = getEmbedder();
    const supabase = getSupabaseService();

    try {
      const messages = await this.fetchChannelHistory(channelId, 200);

      if (messages.length === 0) {
        return { rowsProcessed: 0, status: 'success' };
      }

      // Get tenant_id from connection
      const { data: connection } = await supabase.getClient()
        .from('api_connections')
        .select('tenant_id')
        .eq('id', this.connectionId)
        .single();

      if (!connection) {
        throw new Error('Connection not found');
      }

      const tenantId = (connection as Record<string, unknown>).tenant_id as string;

      // Chunk messages into batches for embedding
      const chunks = messages.map((msg) => ({
        content: `[${new Date(Number(msg.ts) * 1000).toISOString()}] ${msg.user ?? 'unknown'}: ${msg.text ?? ''}`,
        metadata: {
          source_type: 'slack',
          channel_id: channelId,
          message_ts: msg.ts,
          user: msg.user,
          thread_ts: msg.thread_ts,
        },
      }));

      await embedder.processBatch(tenantId, 'slack_message', channelId, chunks);

      // Log context event
      await supabase.getClient().from('context_events').insert({
        tenant_id: tenantId,
        source_type: 'slack',
        source_id: channelId,
        event_type: 'bulk_sync',
        content: `Synced ${messages.length} Slack messages from channel ${channelId}`,
        metadata: { message_count: messages.length },
      });

      return { rowsProcessed: messages.length, status: 'success' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { rowsProcessed: 0, status: 'error', error: errorMsg };
    }
  }

  private async listChannels(): Promise<Array<{
    id: string;
    name: string;
    is_private: boolean;
    num_members: number;
  }>> {
    const response = await fetch(
      'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200',
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    const data = await response.json() as {
      ok: boolean;
      channels?: Array<{ id: string; name: string; is_private: boolean; num_members: number }>;
    };
    return data.channels ?? [];
  }

  private async fetchChannelHistory(
    channelId: string,
    limit: number
  ): Promise<Array<{
    ts: string;
    user?: string;
    text?: string;
    thread_ts?: string;
  }>> {
    const response = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    const data = await response.json() as {
      ok: boolean;
      messages?: Array<{ ts: string; user?: string; text?: string; thread_ts?: string }>;
    };
    return data.messages ?? [];
  }
}
