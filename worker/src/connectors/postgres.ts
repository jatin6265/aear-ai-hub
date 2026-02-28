import { Client } from 'pg';
import { BaseConnector } from './base';
import { 
  classifyEntityGroup, 
  detectSensitivityByName, 
  riskLevelFromSensitivity 
} from '../lib/discovery-helpers';
import { sanitizeName } from '../lib/utils';

export class PostgresConnector extends BaseConnector {
  async validateConnection(): Promise<boolean> {
    const client = new Client(this.getClientConfig());
    try {
      await client.connect();
      return true;
    } catch (err) {
      console.error('Postgres validation failed:', err);
      return false;
    } finally {
      await client.end();
    }
  }

  async discoverSchema(): Promise<{
    entities: unknown[];
    relationships: unknown[];
    schemaTablesCount: number;
    schemaEntitiesCount: number;
  }> {
    const client = new Client(this.getClientConfig());
    await client.connect();
    try {
      const tablesQuery = `
        SELECT
          t.table_schema AS schema_name,
          t.table_name AS table_name,
          COALESCE(c.reltuples::bigint, 0) AS row_estimate
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
        WHERE t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.table_schema, t.table_name
        LIMIT 250
      `;

      const columnsQuery = `
        SELECT
          c.table_schema AS schema_name,
          c.table_name AS table_name,
          c.column_name AS column_name,
          c.data_type AS data_type,
          c.is_nullable AS is_nullable
        FROM information_schema.columns c
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        LIMIT 8000
      `;

      const [tablesResult, columnsResult] = await Promise.all([
        client.query(tablesQuery),
        client.query(columnsQuery)
      ]);

      const columnsByTable = new Map();
      for (const row of columnsResult.rows) {
        const key = `${row.schema_name}.${row.table_name}`;
        if (!columnsByTable.has(key)) columnsByTable.set(key, []);
        columnsByTable.get(key).push({
          name: sanitizeName(row.column_name),
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          sensitivity: detectSensitivityByName(row.column_name)
        });
      }

      const entities = tablesResult.rows.map(row => {
        const tableKey = `${row.schema_name}.${row.table_name}`;
        const sensitivity = detectSensitivityByName(row.table_name);
        return {
          name: sanitizeName(`${row.schema_name}_${row.table_name}`),
          sourceKind: 'table',
          entityGroup: classifyEntityGroup(row.table_name),
          rowCount: Number(row.row_estimate),
          riskLevel: riskLevelFromSensitivity(sensitivity),
          sensitivity,
          description: `Postgres table ${row.schema_name}.${row.table_name}`,
          columns: columnsByTable.get(tableKey) || []
        };
      });

      return {
        entities,
        relationships: [], // TODO: implement foreign key discovery
        schemaTablesCount: entities.length,
        schemaEntitiesCount: entities.length
      };
    } finally {
      await client.end();
    }
  }

  async syncEntity(entityName: string): Promise<{ rowsProcessed: number; status: 'success' }> {
    // Basic implementation for sync
    return { rowsProcessed: 0, status: 'success' };
  }

  private getClientConfig(): import('pg').ClientConfig {
    if (this.config.connection_string && typeof this.config.connection_string === 'string') {
      return { connectionString: this.config.connection_string };
    }
    return {
      host: String(this.config.host || 'localhost'),
      port: Number(this.config.port) || 5432,
      database: String(this.config.database || 'postgres'),
      user: String(this.config.username || this.config.user || 'postgres'),
      password: String(this.config.password || ''),
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false
    };
  }
}
