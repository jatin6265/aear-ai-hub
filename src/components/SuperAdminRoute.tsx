import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

export default function SuperAdminRoute() {
  const { user, loading } = useAuth();
  const [checkingRole, setCheckingRole] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsSuperAdmin(false);
      setCheckingRole(false);
      return;
    }

    let cancelled = false;

    const check = async () => {
      setCheckingRole(true);
      try {
        const metadataFlag =
          user.user_metadata?.superadmin === true ||
          user.user_metadata?.super_admin === true ||
          user.app_metadata?.superadmin === true ||
          user.app_metadata?.super_admin === true;

        if (metadataFlag) {
          if (!cancelled) setIsSuperAdmin(true);
          return;
        }

        const { data, error } = await supabase
          .from("platform_admin_users")
          .select("user_id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (cancelled) return;
        if (error) {
          setIsSuperAdmin(false);
          return;
        }

        setIsSuperAdmin(Boolean(data?.user_id));
      } catch {
        if (!cancelled) setIsSuperAdmin(false);
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
  if (!isSuperAdmin) return <Navigate to="/dashboard" replace />;

  return <Outlet />;
}
