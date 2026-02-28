import { BaseConnector } from "./base";
import { ConnectorFactory } from "./factory";

/**
 * Compatibility wrapper expected by the Phase 1 build plan.
 * Delegates to the connector factory and canonical connector implementations.
 */
export class DatabaseConnector extends BaseConnector {
  private connectionType: string;

  constructor(connectionId: string, connectionType: string, config: Record<string, unknown>) {
    super(connectionId, config);
    this.connectionType = connectionType;
  }

  private delegate() {
    return ConnectorFactory.createConnector(this.connectionId, this.connectionType, this.config);
  }

  async validateConnection(): Promise<boolean> {
    return await this.delegate().validateConnection();
  }

  async discoverSchema(): Promise<{
    entities: unknown[];
    relationships: unknown[];
    schemaTablesCount: number;
    schemaEntitiesCount: number;
  }> {
    return await this.delegate().discoverSchema();
  }

  async syncEntity(entityName: string): Promise<{
    rowsProcessed: number;
    status: "success" | "error" | "partial";
    error?: string;
  }> {
    return await this.delegate().syncEntity(entityName);
  }
}
