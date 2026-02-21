import { CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';

const mockApprovals = [
  { id: '1', action: 'DELETE /api/orders/bulk', resource: 'OrderService', risk: 'high', status: 'pending', requestedBy: 'john@co.com', time: '10 min ago' },
  { id: '2', action: 'POST /api/users/migrate', resource: 'UserService', risk: 'high', status: 'pending', requestedBy: 'system', time: '30 min ago' },
  { id: '3', action: 'PUT /api/config/billing', resource: 'BillingService', risk: 'medium', status: 'pending', requestedBy: 'admin@co.com', time: '1h ago' },
  { id: '4', action: 'POST /api/reports/generate', resource: 'ReportService', risk: 'low', status: 'approved', requestedBy: 'jane@co.com', time: '2h ago' },
];

const riskColors: Record<string, string> = {
  low: 'bg-secondary/10 text-secondary',
  medium: 'bg-accent/10 text-accent',
  high: 'bg-destructive/10 text-destructive',
};

export default function Approvals() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approval Requests</h1>
        <p className="text-sm text-muted-foreground mt-1">Review and approve high-risk actions</p>
      </div>

      <div className="space-y-3">
        {mockApprovals.map((req) => (
          <div key={req.id} className="bg-card rounded-xl border border-border p-5 hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                {req.risk === 'high' ? (
                  <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
                ) : (
                  <Clock className="w-5 h-5 text-accent shrink-0" />
                )}
                <div>
                  <p className="text-sm font-mono font-medium">{req.action}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {req.resource} · Requested by {req.requestedBy} · {req.time}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${riskColors[req.risk]}`}>
                  {req.risk}
                </span>
                {req.status === 'pending' && (
                  <>
                    <Button size="sm" variant="outline" className="h-8 gap-1 text-xs">
                      <XCircle className="w-3.5 h-3.5" /> Deny
                    </Button>
                    <Button size="sm" className="h-8 gap-1 text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                    </Button>
                  </>
                )}
                {req.status === 'approved' && (
                  <span className="text-xs text-secondary font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Approved
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
