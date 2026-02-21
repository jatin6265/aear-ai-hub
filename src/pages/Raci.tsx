const mockRaci = [
  { resource: '/api/users', action: 'CREATE', roles: { Admin: 'R', Manager: 'A', Developer: 'C', Viewer: 'I' } },
  { resource: '/api/orders', action: 'DELETE', roles: { Admin: 'A', Manager: 'R', Developer: 'C', Viewer: 'I' } },
  { resource: '/api/payments', action: 'EXECUTE', roles: { Admin: 'A', Manager: 'A', Developer: 'R', Viewer: 'I' } },
  { resource: '/api/reports', action: 'READ', roles: { Admin: 'I', Manager: 'R', Developer: 'C', Viewer: 'R' } },
];

const raciColors: Record<string, string> = {
  R: 'bg-accent/10 text-accent font-bold',
  A: 'bg-destructive/10 text-destructive font-bold',
  C: 'bg-secondary/10 text-secondary font-bold',
  I: 'bg-muted text-muted-foreground',
};

const roles = ['Admin', 'Manager', 'Developer', 'Viewer'];

export default function Raci() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">RACI Matrix</h1>
        <p className="text-sm text-muted-foreground mt-1">Define responsibility assignments for API actions</p>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Resource</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Action</th>
              {roles.map((r) => (
                <th key={r} className="text-center text-xs font-medium text-muted-foreground px-4 py-3">{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mockRaci.map((row, i) => (
              <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 text-sm font-mono text-xs">{row.resource}</td>
                <td className="px-4 py-3 text-sm font-medium">{row.action}</td>
                {roles.map((role) => (
                  <td key={role} className="px-4 py-3 text-center">
                    <span className={`inline-flex w-7 h-7 items-center justify-center rounded-md text-xs ${raciColors[row.roles[role as keyof typeof row.roles]]}`}>
                      {row.roles[role as keyof typeof row.roles]}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
