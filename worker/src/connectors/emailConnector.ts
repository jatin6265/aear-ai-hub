import { BaseConnector } from './base';
import { getSupabaseService } from '../lib/supabase';
import { getEmbedder } from '../pipeline/embedder';

/**
 * Email connector: indexes Gmail/Outlook threads.
 *
 * Supports: Gmail API, Microsoft Graph API (Outlook)
 * Auth: OAuth 2.0
 */
export class EmailConnector extends BaseConnector {
  private get provider(): 'gmail' | 'outlook' {
    const p = String(this.config.provider || 'gmail').toLowerCase();
    return p === 'outlook' ? 'outlook' : 'gmail';
  }

  private get accessToken(): string {
    return String(this.config.access_token || '');
  }

  async validateConnection(): Promise<boolean> {
    try {
      if (this.provider === 'gmail') {
        const response = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/profile',
          { headers: { Authorization: `Bearer ${this.accessToken}` } }
        );
        return response.ok;
      } else {
        const response = await fetch(
          'https://graph.microsoft.com/v1.0/me',
          { headers: { Authorization: `Bearer ${this.accessToken}` } }
        );
        return response.ok;
      }
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
    const labels = this.provider === 'gmail' ? await this.getGmailLabels() : [];

    const entities = [
      {
        name: 'inbox',
        sourceKind: 'email_thread',
        entityGroup: 'communication',
        rowCount: 0,
        riskLevel: 'low' as const,
        sensitivity: ['communication'],
        description: `${this.provider} inbox threads`,
        columns: [
          { name: 'subject', dataType: 'text', nullable: false, sensitivity: [] },
          { name: 'from', dataType: 'text', nullable: false, sensitivity: ['pii'] },
          { name: 'body', dataType: 'text', nullable: false, sensitivity: [] },
          { name: 'date', dataType: 'timestamp', nullable: false, sensitivity: [] },
        ],
      },
      ...labels.map((label) => ({
        name: label.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        sourceKind: 'email_label',
        entityGroup: 'communication',
        rowCount: 0,
        riskLevel: 'low' as const,
        sensitivity: ['communication'],
        description: `Gmail label: ${label.name}`,
        columns: [],
      })),
    ];

    return {
      entities,
      relationships: [],
      schemaTablesCount: entities.length,
      schemaEntitiesCount: entities.length,
    };
  }

  async syncEntity(labelOrFolder: string): Promise<{
    rowsProcessed: number;
    status: 'success' | 'error' | 'partial';
    error?: string;
  }> {
    const embedder = getEmbedder();
    const supabase = getSupabaseService();

    try {
      const { data: connection } = await supabase.getClient()
        .from('api_connections')
        .select('tenant_id')
        .eq('id', this.connectionId)
        .single();

      if (!connection) throw new Error('Connection not found');
      const tenantId = (connection as Record<string, unknown>).tenant_id as string;

      const messages =
        this.provider === 'gmail'
          ? await this.fetchGmailMessages(labelOrFolder, 100)
          : await this.fetchOutlookMessages(100);

      if (messages.length === 0) {
        return { rowsProcessed: 0, status: 'success' };
      }

      const chunks = messages.map((msg) => ({
        content: [
          `Subject: ${msg.subject ?? '(no subject)'}`,
          `From: ${msg.from ?? 'unknown'}`,
          `Date: ${msg.date ?? 'unknown'}`,
          `Body: ${('snippet' in msg ? msg.snippet : 'body' in msg ? msg.body : '') ?? ''.slice(0, 1000)}`,
        ].join('\n'),
        metadata: {
          source_type: 'email',
          provider: this.provider,
          message_id: msg.id,
          subject: msg.subject,
          from: msg.from,
          date: msg.date,
          label: labelOrFolder,
        },
      }));

      await embedder.processBatch(tenantId, 'email_thread', labelOrFolder, chunks);

      await supabase.getClient().from('context_events').insert({
        tenant_id: tenantId,
        source_type: 'email',
        source_id: labelOrFolder,
        event_type: 'bulk_sync',
        content: `Indexed ${messages.length} email threads from ${labelOrFolder}`,
        metadata: { message_count: messages.length, provider: this.provider },
      });

      return { rowsProcessed: messages.length, status: 'success' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { rowsProcessed: 0, status: 'error', error: errorMsg };
    }
  }

  private async getGmailLabels(): Promise<Array<{ id: string; name: string }>> {
    const response = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    const data = await response.json() as { labels?: Array<{ id: string; name: string }> };
    return (data.labels ?? []).filter((l) =>
      !['CHAT', 'SENT', 'TRASH', 'SPAM', 'DRAFT'].includes(l.name.toUpperCase())
    );
  }

  private async fetchGmailMessages(
    labelId: string,
    maxResults: number
  ): Promise<Array<{ id: string; subject?: string; from?: string; date?: string; snippet?: string }>> {
    const listResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${encodeURIComponent(labelId)}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    const listData = await listResponse.json() as {
      messages?: Array<{ id: string; threadId: string }>
    };

    if (!listData.messages) return [];

    // Fetch first 20 message details (rate limit consideration)
    const messages = await Promise.all(
      listData.messages.slice(0, 20).map(async (msg) => {
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject,From,Date`,
          { headers: { Authorization: `Bearer ${this.accessToken}` } }
        );
        const msgData = await msgResponse.json() as {
          id: string;
          snippet?: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
        };

        const headers = msgData.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

        return {
          id: msgData.id,
          subject: getHeader('Subject'),
          from: getHeader('From'),
          date: getHeader('Date'),
          snippet: msgData.snippet,
        };
      })
    );

    return messages;
  }

  private async fetchOutlookMessages(
    maxResults: number
  ): Promise<Array<{ id: string; subject?: string; from?: string; date?: string; body?: string }>> {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$top=${maxResults}&$select=id,subject,from,receivedDateTime,bodyPreview`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    const data = await response.json() as {
      value?: Array<{
        id: string;
        subject?: string;
        from?: { emailAddress?: { address?: string } };
        receivedDateTime?: string;
        bodyPreview?: string;
      }>;
    };

    return (data.value ?? []).map((msg) => ({
      id: msg.id,
      subject: msg.subject,
      from: msg.from?.emailAddress?.address,
      date: msg.receivedDateTime,
      body: msg.bodyPreview,
    }));
  }
}
