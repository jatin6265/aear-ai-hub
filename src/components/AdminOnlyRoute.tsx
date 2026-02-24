import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";

export default function AdminOnlyRoute() {
  const { user, loading } = useAuth();
  const [checkingRole, setCheckingRole] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      setCheckingRole(false);
      return;
    }

    let cancelled = false;

    const check = async () => {
      setCheckingRole(true);
      try {
        const workspace = await ensureUserWorkspace(user);
        if (cancelled) return;
        const role = (workspace.role || "").toLowerCase();
        setIsAdmin(role === "admin" || role === "owner");
      } catch {
        if (cancelled) return;
        setIsAdmin(false);
      } finally {
        if (!cancelled) setCheckingRole(false);
      }
    };

    void check();

    return () => {
      cancelled = true;
    };
  }, [user]);

  if (loading || checkingRole) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-pulse rounded-lg bg-gradient-to-br from-violet-500 to-purple-600" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth/login" replace />;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;

  return <Outlet />;
}
