import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, MailWarning } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { consumeAuthLinkFromLocation } from "@/lib/auth-link";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";

type Status = "loading" | "success" | "error";

export default function ConfirmEmailPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("Validating your confirmation link...");

  useEffect(() => {
    let active = true;
    let timer: number | null = null;

    const run = async () => {
      setStatus("loading");
      setMessage("Validating your confirmation link...");

      const consumed = await consumeAuthLinkFromLocation("confirm");
      if (!active) return;

      if (!consumed.ok) {
        const { data: fallbackUser } = await supabase.auth.getUser();
        if (fallbackUser.user) {
          setStatus("success");
          setMessage("Your email is already confirmed. Redirecting to workspace...");
          timer = window.setTimeout(() => {
            navigate("/onboarding", { replace: true });
          }, 1200);
          return;
        }
        setStatus("error");
        setMessage(consumed.error || "Link expired or invalid. Request a new one.");
        return;
      }

      const { data: userData } = await supabase.auth.getUser();
      if (userData.user) {
        try {
          await ensureUserWorkspace(userData.user);
        } catch {
          // Workspace can still be provisioned lazily after redirect.
        }
      }

      if (!active) return;

      setStatus("success");
      setMessage("Email confirmed! Setting up your workspace...");

      timer = window.setTimeout(() => {
        navigate("/onboarding", { replace: true });
      }, 2000);
    };

    void run();

    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/70">
        {status === "loading" ? (
          <div className="space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Confirming your email</h1>
            <p className="text-sm text-slate-600">{message}</p>
          </div>
        ) : status === "success" ? (
          <div className="space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Email confirmed</h1>
            <p className="text-sm text-slate-600">{message}</p>
            <p className="text-xs text-slate-500">Redirecting to onboarding in 2 seconds...</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-rose-100 text-rose-700">
              <MailWarning className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Confirmation failed</h1>
            <p className="text-sm text-slate-600">{message}</p>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/auth/verify-email"
                className="inline-flex rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
              >
                Request new link
              </Link>
              <Link
                to="/auth/login"
                className="inline-flex rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Back to login
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
