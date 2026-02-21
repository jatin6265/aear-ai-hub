import { ScrollText } from 'lucide-react';

const mockLogs = [
  { action: 'api.connection.create', resource: 'StripeAPI', risk_level: 'low', status: 'success', time: '2 min ago', user: 'jane@co.com' },
  { action: 'api.schema.sync', resource: 'PaymentGateway', risk_level: 'medium', status: 'success', time: '15 min ago', user: 'system' },
  { action: 'api.action.execute', resource: 'OrderService', risk_level: 'high', status: 'approved', time: '1h ago', user: 'john@co.com' },
  { action: 'auth.login', resource: 'AuthService', risk_level: 'low', status: 'success', time: '2h ago', user: 'jane@co.com' },
  { action: 'api.connection.delete', resource: 'LegacyCRM', risk_level: 'high', status: 'pending', time: '3h ago', user: 'admin@co.com' },
];

const riskColors: Record<string, string> = {
  low: 'bg-secondary/10 text-secondary',
  medium: 'bg-accent/10 text-accent',
  high: 'bg-destructive/10 text-destructive',
};

const statusColors: Record<string, string> = {
  success: 'text-secondary',
  approved: 'text-accent',
  pending: 'text-muted-foreground',
};

export default function AuditLogs() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit Logs</h1>
        <p className="text-sm text-muted-foreground mt-1">Complete activity trail for compliance</p>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Action</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Resource</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">User</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Risk</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Status</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Time</th>
            </tr>
          </thead>
          <tbody>
            {mockLogs.map((log, i) => (
              <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 text-sm font-mono text-xs">{log.action}</td>
                <td className="px-4 py-3 text-sm">{log.resource}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{log.user}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${riskColors[log.risk_level]}`}>
                    {log.risk_level}
                  </span>
                </td>
                <td className={`px-4 py-3 text-sm font-medium ${statusColors[log.status]}`}>{log.status}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{log.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
