import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

export default function ProtectedRoute() {
  const { user, session, loading, emailVerified } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-lg gradient-accent animate-pulse" />
      </div>
    );
  }

  if (!user || !session) return <Navigate to="/auth/login" replace />;
  if (!emailVerified) {
    const email = typeof user.email === "string" ? user.email : "";
    const target = email
      ? `/auth/verify-email?email=${encodeURIComponent(email)}`
      : "/auth/verify-email";
    return <Navigate to={target} replace />;
  }

  return <Outlet />;
}
