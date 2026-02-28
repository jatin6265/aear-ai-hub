import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import AdminOnlyRoute from "./components/AdminOnlyRoute";
import SuperAdminRoute from "./components/SuperAdminRoute";
import OnboardingGuard from "./components/OnboardingGuard";
import AppErrorBoundary from "./components/AppErrorBoundary";

const LandingPage = lazy(() => import("./pages/LandingPage"));
const PricingPage = lazy(() => import("./pages/PricingPage"));
const Auth = lazy(() => import("./pages/Auth"));
const NotFound = lazy(() => import("./pages/NotFound"));
const LegalPage = lazy(() => import("./pages/LegalPage"));
const AppLayout = lazy(() => import("./layouts/AppLayout"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Chat = lazy(() => import("./pages/Chat"));
const Insights = lazy(() => import("./pages/Insights"));
const InsightAnomalyDetail = lazy(() => import("./pages/InsightAnomalyDetail"));
const Connections = lazy(() => import("./pages/Connections"));
const ConnectionSchemaDetail = lazy(() => import("./pages/ConnectionSchemaDetail"));
const KnowledgeBase = lazy(() => import("./pages/KnowledgeBase"));
const Tools = lazy(() => import("./pages/Tools"));
const Agents = lazy(() => import("./pages/Agents"));
const AgentDetail = lazy(() => import("./pages/AgentDetail"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const Raci = lazy(() => import("./pages/Raci"));
const RaciRoles = lazy(() => import("./pages/RaciRoles"));
const AuditLogs = lazy(() => import("./pages/AuditLogs"));
const Approvals = lazy(() => import("./pages/Approvals"));
const Guardrails = lazy(() => import("./pages/Guardrails"));
const AdminConsole = lazy(() => import("./pages/AdminConsole"));
const AdminAnalytics = lazy(() => import("./pages/AdminAnalytics"));
const Team = lazy(() => import("./pages/Team"));
const ApiKeys = lazy(() => import("./pages/ApiKeys"));
const Billing = lazy(() => import("./pages/Billing"));
const BillingUpgrade = lazy(() => import("./pages/BillingUpgrade"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const NotificationSettings = lazy(() => import("./pages/NotificationSettings"));
const WidgetIntegration = lazy(() => import("./pages/WidgetIntegration"));
const WidgetIntegrationTest = lazy(() => import("./pages/WidgetIntegrationTest"));
const PlatformAdminTenants = lazy(() => import("./pages/PlatformAdminTenants"));
const PlatformAdminRevenue = lazy(() => import("./pages/PlatformAdminRevenue"));
const PlatformAdminInfrastructure = lazy(() => import("./pages/PlatformAdminInfrastructure"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const LoginPage = lazy(() => import("./pages/auth/LoginPage"));
const SignUpPage = lazy(() => import("./pages/auth/SignUpPage"));
const VerifyEmailPage = lazy(() => import("./pages/auth/VerifyEmailPage"));
const ForgotPasswordPage = lazy(() => import("./pages/auth/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("./pages/auth/ResetPasswordPage"));
const ConfirmEmailPage = lazy(() => import("./pages/auth/ConfirmEmailPage"));
const MagicLinkPage = lazy(() => import("./pages/auth/MagicLinkPage"));
const InviteAcceptPage = lazy(() => import("./pages/InviteAcceptPage"));

function RouteFallback() {
  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}

const App = () => (
  <TooltipProvider>
    <Toaster />
    <Sonner />
    <BrowserRouter>
      <AppErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/legal/:doc" element={<LegalPage />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/auth/login" element={<LoginPage />} />
          <Route path="/auth/signup" element={<SignUpPage />} />
          <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
          <Route path="/auth/confirm-email" element={<ConfirmEmailPage />} />
          <Route path="/auth/magic-link" element={<MagicLinkPage />} />
          <Route path="/invite/accept" element={<InviteAcceptPage />} />
          <Route path="/auth/*" element={<Navigate to="/auth/login" replace />} />

          <Route element={<ProtectedRoute />}>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route element={<SuperAdminRoute />}>
              <Route path="/platform-admin/tenants" element={<PlatformAdminTenants />} />
              <Route path="/platform-admin/revenue" element={<PlatformAdminRevenue />} />
              <Route path="/platform-admin/infrastructure" element={<PlatformAdminInfrastructure />} />
            </Route>

            <Route element={<AppLayout />}>
              <Route element={<OnboardingGuard />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/dashboard/chat" element={<Chat />} />
                <Route path="/dashboard/insights" element={<Insights />} />
                <Route path="/dashboard/insights/:id" element={<InsightAnomalyDetail />} />
                <Route path="/dashboard/connections" element={<Connections />} />
                <Route path="/dashboard/connections/:id" element={<ConnectionSchemaDetail />} />
                <Route path="/dashboard/knowledge" element={<KnowledgeBase />} />
                <Route path="/dashboard/tools" element={<Tools />} />
                <Route path="/dashboard/agents" element={<Agents />} />
                <Route path="/dashboard/agents/:id" element={<AgentDetail />} />
                <Route path="/dashboard/marketplace" element={<Marketplace />} />
                <Route path="/dashboard/raci" element={<Raci />} />
                <Route path="/dashboard/raci/roles" element={<RaciRoles />} />
                <Route path="/dashboard/approvals" element={<Approvals />} />
                <Route path="/dashboard/audit" element={<AuditLogs />} />
                <Route path="/dashboard/guardrails" element={<Guardrails />} />
                <Route path="/dashboard/team" element={<Team />} />
                <Route path="/dashboard/api-keys" element={<ApiKeys />} />
                <Route path="/dashboard/billing" element={<Billing />} />
                <Route path="/dashboard/billing/upgrade" element={<BillingUpgrade />} />
                <Route path="/dashboard/settings" element={<SettingsPage />} />
                <Route path="/dashboard/settings/notifications" element={<NotificationSettings />} />
                <Route path="/dashboard/settings/widget" element={<WidgetIntegration />} />
                <Route path="/dashboard/settings/widget/test" element={<WidgetIntegrationTest />} />
                <Route element={<AdminOnlyRoute />}>
                  <Route path="/dashboard/admin" element={<AdminConsole />} />
                  <Route path="/dashboard/admin/analytics" element={<AdminAnalytics />} />
                </Route>
              </Route>
            </Route>

            <Route path="/chat" element={<Navigate to="/dashboard/chat" replace />} />
            <Route path="/connections/new" element={<Navigate to="/dashboard/connections" replace />} />
            <Route path="/connections" element={<Navigate to="/dashboard/connections" replace />} />
            <Route path="/marketplace" element={<Navigate to="/dashboard/marketplace" replace />} />
            <Route path="/raci" element={<Navigate to="/dashboard/raci" replace />} />
            <Route path="/team" element={<Navigate to="/dashboard/team" replace />} />
            <Route path="/billing" element={<Navigate to="/dashboard/billing" replace />} />
            <Route path="/billing/upgrade" element={<Navigate to="/dashboard/billing/upgrade" replace />} />
            <Route path="/guardrails" element={<Navigate to="/dashboard/guardrails" replace />} />
            <Route path="/audit" element={<Navigate to="/dashboard/audit" replace />} />
            <Route path="/approvals" element={<Navigate to="/dashboard/approvals" replace />} />
            <Route path="/usage" element={<Navigate to="/dashboard/billing" replace />} />
            <Route path="/settings" element={<Navigate to="/dashboard/settings" replace />} />
            <Route path="/settings/notifications" element={<Navigate to="/dashboard/settings/notifications" replace />} />
            <Route path="/settings/widget" element={<Navigate to="/dashboard/settings/widget" replace />} />
            <Route path="/settings/widget/test" element={<Navigate to="/dashboard/settings/widget/test" replace />} />
            <Route path="/platform-admin" element={<Navigate to="/platform-admin/tenants" replace />} />
            <Route path="/admin" element={<Navigate to="/dashboard/admin" replace />} />
            <Route path="/admin/analytics" element={<Navigate to="/dashboard/admin/analytics" replace />} />
          </Route>

          <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </AppErrorBoundary>
    </BrowserRouter>
  </TooltipProvider>
);

export default App;
