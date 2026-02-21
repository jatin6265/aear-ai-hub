import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-lg gradient-accent animate-pulse" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  return <Outlet />;
}
