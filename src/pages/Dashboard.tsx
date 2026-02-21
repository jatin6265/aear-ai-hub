import {
  BarChart3,
  Plug,
  MessageSquare,
  Shield,
  AlertTriangle,
  CheckCircle2,
  ArrowUpRight,
} from 'lucide-react';
import { Link } from 'react-router-dom';

const stats = [
  { label: 'API Connections', value: '12', change: '+2 this week', icon: Plug, color: 'text-secondary' },
  { label: 'Chat Sessions', value: '48', change: '+8 today', icon: MessageSquare, color: 'text-accent' },
  { label: 'Approvals Pending', value: '3', change: '2 high-risk', icon: AlertTriangle, color: 'text-destructive' },
  { label: 'Actions Completed', value: '156', change: '99.2% success', icon: CheckCircle2, color: 'text-secondary' },
];

const recentActivity = [
  { action: 'POST /api/users created', resource: 'UserService', risk: 'low', time: '2m ago' },
  { action: 'Schema sync completed', resource: 'PaymentGateway', risk: 'medium', time: '15m ago' },
  { action: 'Approval granted: DELETE /orders', resource: 'OrderService', risk: 'high', time: '1h ago' },
  { action: 'New connection added', resource: 'AnalyticsAPI', risk: 'low', time: '3h ago' },
];

const riskColors: Record<string, string> = {
  low: 'bg-secondary/10 text-secondary',
  medium: 'bg-accent/10 text-accent',
  high: 'bg-destructive/10 text-destructive',
};

export default function Dashboard() {
  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Overview of your AI runtime environment</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, change, icon: Icon, color }) => (
          <div
            key={label}
            className="bg-card rounded-xl border border-border p-5 hover:shadow-lg transition-shadow"
          >
            <div className="flex items-center justify-between mb-3">
              <Icon className={`w-5 h-5 ${color}`} />
              <ArrowUpRight className="w-4 h-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{label}</p>
            <p className="text-xs text-secondary mt-1 font-medium">{change}</p>
          </div>
        ))}
      </div>

      {/* Quick actions + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Quick Actions</h2>
          <div className="space-y-2">
            <Link
              to="/chat"
              className="flex items-center gap-3 bg-card rounded-xl border border-border p-4 hover:shadow-lg hover:border-accent/30 transition-all group"
            >
              <div className="w-10 h-10 rounded-lg gradient-accent flex items-center justify-center shrink-0">
                <MessageSquare className="w-5 h-5 text-accent-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium group-hover:text-accent transition-colors">New AI Chat</p>
                <p className="text-xs text-muted-foreground">Start a conversation with the runtime</p>
              </div>
            </Link>
            <Link
              to="/connections"
              className="flex items-center gap-3 bg-card rounded-xl border border-border p-4 hover:shadow-lg hover:border-secondary/30 transition-all group"
            >
              <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                <Plug className="w-5 h-5 text-secondary-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium group-hover:text-secondary transition-colors">Add Connection</p>
                <p className="text-xs text-muted-foreground">Connect a new API endpoint</p>
              </div>
            </Link>
            <Link
              to="/approvals"
              className="flex items-center gap-3 bg-card rounded-xl border border-border p-4 hover:shadow-lg hover:border-destructive/30 transition-all group"
            >
              <div className="w-10 h-10 rounded-lg bg-destructive flex items-center justify-center shrink-0">
                <Shield className="w-5 h-5 text-destructive-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium group-hover:text-destructive transition-colors">Review Approvals</p>
                <p className="text-xs text-muted-foreground">3 pending approval requests</p>
              </div>
            </Link>
          </div>
        </div>

        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">Recent Activity</h2>
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Action</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Resource</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Risk</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Time</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map((item, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-sm font-mono text-xs">{item.action}</td>
                    <td className="px-4 py-3 text-sm">{item.resource}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${riskColors[item.risk]}`}>
                        {item.risk}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{item.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
