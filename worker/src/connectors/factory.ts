import { BaseConnector } from './base';
import { PostgresConnector } from './postgres';
import { SlackConnector } from './slackConnector';
import { DriveConnector } from './driveConnector';
import { EmailConnector } from './emailConnector';

export class ConnectorFactory {
  static createConnector(
    connectionId: string,
    connectionType: string,
    config: Record<string, unknown>
  ): BaseConnector {
    switch (connectionType.toLowerCase()) {
      case 'postgres':
      case 'postgresql':
      case 'supabase':
        return new PostgresConnector(connectionId, config);

      case 'slack':
        return new SlackConnector(connectionId, config);

      case 'google_drive':
      case 'drive':
        return new DriveConnector(connectionId, config);

      case 'gmail':
      case 'outlook':
      case 'email':
        return new EmailConnector(connectionId, config);

      // MySQL/MongoDB support can be added as separate connectors
      default:
        throw new Error(`Unsupported connection type: ${connectionType}`);
    }
  }
}
