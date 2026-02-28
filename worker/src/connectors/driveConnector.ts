import { BaseConnector } from './base';
import { getSupabaseService } from '../lib/supabase';
import { getEmbedder } from '../pipeline/embedder';

/**
 * Google Drive connector: syncs files and indexes their content.
 *
 * Supports: Google Docs, Sheets, Slides, PDFs via Drive API
 * Auth: OAuth 2.0
 */
export class DriveConnector extends BaseConnector {
  private get accessToken(): string {
    return String(this.config.access_token || '');
  }

  async validateConnection(): Promise<boolean> {
    try {
      const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return response.ok;
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
    const files = await this.listFiles(50);
    const entities = files.map((file) => ({
      name: file.name,
      sourceKind: 'drive_file',
      entityGroup: 'document',
      rowCount: 0,
      riskLevel: 'low' as const,
      sensitivity: this.classifySensitivity(file.name),
      description: `Google Drive file: ${file.name} (${file.mimeType})`,
      columns: [
        { name: 'content', dataType: 'text', nullable: false, sensitivity: [] },
        { name: 'modified_at', dataType: 'timestamp', nullable: false, sensitivity: [] },
      ],
    }));

    return {
      entities,
      relationships: [],
      schemaTablesCount: entities.length,
      schemaEntitiesCount: entities.length,
    };
  }

  async syncEntity(fileId: string): Promise<{
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

      // Get file metadata
      const fileResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,modifiedTime`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );

      if (!fileResponse.ok) {
        return { rowsProcessed: 0, status: 'error', error: 'File not found or access denied' };
      }

      const fileMetadata = await fileResponse.json() as Record<string, unknown>;
      const content = await this.exportFileContent(fileId, String(fileMetadata.mimeType));

      if (!content) {
        return { rowsProcessed: 0, status: 'partial', error: 'File type not supported for text extraction' };
      }

      // Chunk the content (512 tokens, 50 overlap)
      const chunks = this.chunkText(content, 2048, 200).map((chunk) => ({
        content: chunk,
        metadata: {
          source_type: 'google_drive',
          file_id: fileId,
          file_name: String(fileMetadata.name),
          mime_type: String(fileMetadata.mimeType),
          modified_at: String(fileMetadata.modifiedTime),
        },
      }));

      await embedder.processBatch(tenantId, 'drive_document', fileId, chunks);

      // Log context event
      await supabase.getClient().from('context_events').insert({
        tenant_id: tenantId,
        source_type: 'google_drive',
        source_id: fileId,
        event_type: 'document_indexed',
        content: `Indexed ${chunks.length} chunks from ${String(fileMetadata.name)}`,
        metadata: { file_name: fileMetadata.name, chunk_count: chunks.length },
      });

      return { rowsProcessed: chunks.length, status: 'success' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { rowsProcessed: 0, status: 'error', error: errorMsg };
    }
  }

  private async listFiles(limit: number): Promise<Array<{
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
  }>> {
    const mimeTypes = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
      'application/pdf',
    ].join("','");

    const query = encodeURIComponent(`mimeType in ('${mimeTypes}') and trashed = false`);
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&pageSize=${limit}&fields=files(id,name,mimeType,modifiedTime)`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    const data = await response.json() as {
      files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string }>
    };
    return data.files ?? [];
  }

  private async exportFileContent(fileId: string, mimeType: string): Promise<string | null> {
    let exportMimeType = 'text/plain';
    if (mimeType.includes('spreadsheet')) exportMimeType = 'text/csv';
    if (mimeType === 'application/pdf') {
      // For PDFs, export as plain text
      exportMimeType = 'text/plain';
    }

    const isGoogleApps = mimeType.includes('google-apps');
    const url = isGoogleApps
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) return null;
    return response.text();
  }

  private classifySensitivity(filename: string): string[] {
    const lower = filename.toLowerCase();
    const tags: string[] = [];
    if (lower.includes('finance') || lower.includes('revenue') || lower.includes('invoice')) {
      tags.push('financial');
    }
    if (lower.includes('hr') || lower.includes('employee') || lower.includes('payroll')) {
      tags.push('pii');
    }
    if (lower.includes('contract') || lower.includes('legal') || lower.includes('nda')) {
      tags.push('legal');
    }
    return tags;
  }

  private chunkText(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      chunks.push(text.slice(start, start + chunkSize));
      start += chunkSize - overlap;
    }
    return chunks;
  }
}
