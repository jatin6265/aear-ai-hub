import { Plug, Plus, RefreshCw, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

const mockConnections = [
  { id: '1', name: 'Stripe API', type: 'REST', status: 'active', base_url: 'https://api.stripe.com', schema_detected: true, last_synced_at: '2 min ago' },
  { id: '2', name: 'Slack Webhooks', type: 'Webhook', status: 'active', base_url: 'https://hooks.slack.com', schema_detected: true, last_synced_at: '5 min ago' },
  { id: '3', name: 'Internal CRM', type: 'GraphQL', status: 'pending', base_url: 'https://crm.internal.co', schema_detected: false, last_synced_at: null },
  { id: '4', name: 'Analytics Service', type: 'REST', status: 'error', base_url: 'https://analytics.example.com', schema_detected: false, last_synced_at: null },
];

const statusIcon: Record<string, JSX.Element> = {
  active: <CheckCircle2 className="w-4 h-4 text-secondary" />,
  pending: <Clock className="w-4 h-4 text-accent" />,
  error: <XCircle className="w-4 h-4 text-destructive" />,
};

export default function Connections() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Connections</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your connected services</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" /> Add Connection
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {mockConnections.map((conn) => (
          <div key={conn.id} className="bg-card rounded-xl border border-border p-5 hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Plug className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">{conn.name}</h3>
                  <p className="text-xs text-muted-foreground font-mono">{conn.base_url}</p>
                </div>
              </div>
              {statusIcon[conn.status]}
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="bg-muted px-2 py-0.5 rounded font-medium">{conn.type}</span>
              {conn.schema_detected && <span className="text-secondary">Schema detected</span>}
              {conn.last_synced_at && (
                <span className="flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> {conn.last_synced_at}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
