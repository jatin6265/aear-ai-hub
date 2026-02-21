import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <div className="space-y-6 animate-fade-in max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your workspace configuration</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-6">
        <h2 className="text-base font-semibold">Profile</h2>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={user?.email ?? ''} disabled />
          </div>
          <div className="space-y-2">
            <Label>Full Name</Label>
            <Input placeholder="Your full name" />
          </div>
        </div>
        <Button>Save Changes</Button>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <h2 className="text-base font-semibold">Workspace</h2>
        <div className="space-y-2">
          <Label>Workspace Name</Label>
          <Input placeholder="My Workspace" />
        </div>
        <div className="space-y-2">
          <Label>Region</Label>
          <Input value="us-east" disabled />
        </div>
      </div>
    </div>
  );
}
