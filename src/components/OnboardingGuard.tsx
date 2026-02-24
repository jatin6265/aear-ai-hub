import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ensureUserWorkspace, tenantNeedsOnboarding } from "@/lib/auth-provisioning";

export default function OnboardingGuard() {
  const { user, session, loading } = useAuth();
  const [checking, setChecking] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user || !session) {
      setChecking(false);
      return;
    }

    let active = true;

    const runCheck = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        const requiresOnboarding = await tenantNeedsOnboarding(workspace.tenantId);
        if (!active) return;
        setNeedsOnboarding(requiresOnboarding);
      } catch {
        if (!active) return;
        setNeedsOnboarding(false);
      } finally {
        if (active) setChecking(false);
      }
    };

    void runCheck();

    return () => {
      active = false;
    };
  }, [loading, session, user]);

  if (loading || checking) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-700 to-purple-600 animate-pulse" />
      </div>
    );
  }

  if (needsOnboarding) return <Navigate to="/onboarding" replace />;

  return <Outlet />;
}
