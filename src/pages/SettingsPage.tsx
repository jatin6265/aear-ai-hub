import { FormEvent, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const REGION_OPTIONS = ["us-east", "eu-west", "asia-pacific", "india"];
const SETTINGS_SUB_NAV = [
  { label: "General", to: "/dashboard/settings", end: true },
  { label: "Notifications", to: "/dashboard/settings/notifications" },
  { label: "Widget", to: "/dashboard/settings/widget" },
] as const;

export default function SettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fullName, setFullName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [region, setRegion] = useState("us-east");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      const workspace = await ensureUserWorkspace(user);
      const [profileRes, tenantRes] = await Promise.all([
        supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
        supabase.from("tenants").select("name, region").eq("id", workspace.tenantId).maybeSingle(),
      ]);

      if (profileRes.error) throw profileRes.error;
      if (tenantRes.error) throw tenantRes.error;

      setFullName(profileRes.data?.full_name ?? "");
      setWorkspaceName(tenantRes.data?.name ?? "");
      setRegion(tenantRes.data?.region ?? "us-east");
    } catch (error) {
      toast({
        title: "Could not load settings",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;

    setSaving(true);
    try {
      const workspace = await ensureUserWorkspace(user);

      const [profileRes, tenantRes] = await Promise.all([
        supabase
          .from("profiles")
          .update({ full_name: fullName.trim() || null })
          .eq("id", user.id),
        supabase
          .from("tenants")
          .update({ name: workspaceName.trim() || "Workspace", region })
          .eq("id", workspace.tenantId),
      ]);

      if (profileRes.error) throw profileRes.error;
      if (tenantRes.error) throw tenantRes.error;

      toast({ title: "Settings saved" });
    } catch (error) {
      toast({
        title: "Could not save settings",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6 animate-fade-in">
      <nav className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-1">
          {SETTINGS_SUB_NAV.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "rounded-lg px-3 py-2 text-sm font-medium transition",
                  isActive ? "bg-violet-100 text-violet-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage your workspace configuration.</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold">Profile</h2>
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={user?.email ?? ""} disabled />
              </div>
              <div className="space-y-2">
                <Label>Full Name</Label>
                <Input
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Your full name"
                />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold">Workspace</h2>
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Workspace Name</Label>
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="My Workspace"
                />
              </div>
              <div className="space-y-2">
                <Label>Region</Label>
                <Select value={region} onValueChange={setRegion}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REGION_OPTIONS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>

        <Button type="submit" disabled={loading || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save Changes
        </Button>
      </form>
    </div>
  );
}
