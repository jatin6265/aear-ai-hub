import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ensureUserWorkspace, tenantNeedsOnboarding } from "@/lib/auth-provisioning";

const ONBOARDING_GUARD_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
        const workspace = await withTimeout(
          ensureUserWorkspace(user),
          ONBOARDING_GUARD_TIMEOUT_MS,
          "Workspace provisioning check",
        );
        const requiresOnboarding = await withTimeout(
          tenantNeedsOnboarding(workspace.tenantId),
          ONBOARDING_GUARD_TIMEOUT_MS,
          "Onboarding status check",
        );
        if (!active) return;
        setNeedsOnboarding(requiresOnboarding);
      } catch (error) {
        console.warn("OnboardingGuard fallback mode:", error);
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
  // Re-run only when auth loading finishes or the actual user identity changes.
  // session/user object references change on every TOKEN_REFRESHED — using their
  // IDs prevents a redundant onboarding re-check and dashboard blink on token renewal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user?.id]);

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
