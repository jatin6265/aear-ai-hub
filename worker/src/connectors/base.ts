/**
 * Abstract base class for all data connectors.
 * Defines the contract for schema discovery and data sync.
 */
export abstract class BaseConnector {
  protected config: Record<string, unknown>;
  protected connectionId: string;

  constructor(connectionId: string, config: Record<string, unknown>) {
    this.connectionId = connectionId;
    this.config = config;
  }

  /**
   * Discovers the schema (entities and relationships) from the source.
   */
  abstract discoverSchema(): Promise<{
    entities: unknown[];
    relationships: unknown[];
    schemaTablesCount: number;
    schemaEntitiesCount: number;
  }>;

  /**
   * Performs a data sync for a specific entity.
   */
  abstract syncEntity(entityName: string, options?: Record<string, unknown>): Promise<{
    rowsProcessed: number;
    status: 'success' | 'error' | 'partial';
    error?: string;
  }>;

  /**
   * Validates the connection configuration.
   */
  abstract validateConnection(): Promise<boolean>;
}
