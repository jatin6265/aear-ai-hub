import { BarChart3 } from 'lucide-react';

const mockUsage = [
  { metric: 'API Calls', value: '12,450', limit: '50,000', percent: 25 },
  { metric: 'AI Inferences', value: '3,200', limit: '10,000', percent: 32 },
  { metric: 'Storage', value: '2.4 GB', limit: '10 GB', percent: 24 },
  { metric: 'Team Members', value: '8', limit: '25', percent: 32 },
];

export default function Usage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage & Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">Monitor your resource consumption</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold">Starter Plan</h2>
            <p className="text-sm text-muted-foreground">Trial ends in 14 days</p>
          </div>
          <span className="px-3 py-1 rounded-full bg-secondary/10 text-secondary text-sm font-medium">Active Trial</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {mockUsage.map((item) => (
            <div key={item.metric}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{item.metric}</span>
                <span className="text-xs text-muted-foreground">{item.value} / {item.limit}</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full gradient-accent transition-all"
                  style={{ width: `${item.percent}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
