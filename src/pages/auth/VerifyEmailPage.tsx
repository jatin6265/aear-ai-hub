import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Mail, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

const COOLDOWN_SECONDS = 60;

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const initialEmail = useMemo(() => searchParams.get("email") ?? "", [searchParams]);
  const [email, setEmail] = useState(initialEmail);
  const [cooldown, setCooldown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const { resendVerificationEmail } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = window.setInterval(() => {
      setCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [cooldown]);

  const handleResend = async () => {
    if (!email) return;

    setSubmitting(true);
    const { error } = await resendVerificationEmail(email.trim());
    setSubmitting(false);

    if (error) {
      toast({
        title: "Unable to resend email",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setCooldown(COOLDOWN_SECONDS);
    toast({
      title: "Verification email sent",
      description: "Please check your inbox and spam folder.",
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/80">
        <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
          <Mail className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Check your inbox</h1>
        <p className="mt-2 text-sm text-slate-600">
          We sent a verification link to your email. Confirm your account, then sign in to continue.
        </p>

        <div className="mt-6 space-y-2">
          <label htmlFor="verify-email" className="text-sm font-medium text-slate-800">
            Email address
          </label>
          <Input
            id="verify-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
          />
        </div>

        <Button
          type="button"
          onClick={handleResend}
          className="mt-5 w-full bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
          disabled={submitting || cooldown > 0 || !email.trim()}
        >
          <RotateCw className="h-4 w-4" />
          {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend email"}
        </Button>

        <div className="mt-6 flex items-center justify-between text-sm text-slate-600">
          <Link to="/auth/login" className="font-medium text-violet-700 hover:text-violet-800">
            Back to login
          </Link>
          <Link to="/auth/signup" className="font-medium text-violet-700 hover:text-violet-800">
            Use another email
          </Link>
        </div>
      </div>
    </div>
  );
}
