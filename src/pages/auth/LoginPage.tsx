import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import AuthSplitLayout from "@/components/auth/AuthSplitLayout";
import GoogleIcon from "@/components/auth/GoogleIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

const REMEMBER_EMAIL_KEY = "opsai.rememberEmail";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { user, loading, signIn, signInWithGoogle, emailVerified } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const remembered = localStorage.getItem(REMEMBER_EMAIL_KEY);
    if (remembered) {
      setEmail(remembered);
      setRememberMe(true);
    }
  }, []);

  useEffect(() => {
    if (!loading && user && emailVerified) navigate("/dashboard", { replace: true });
  }, [emailVerified, loading, navigate, user]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);

    const { error, role } = await signIn(email.trim(), password);
    setSubmitting(false);

    if (error) {
      toast({
        title: "Unable to sign in",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData?.nextLevel === "aal2" && aalData.currentLevel !== "aal2") {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (factorsError) {
        toast({
          title: "MFA check failed",
          description: factorsError.message,
          variant: "destructive",
        });
        return;
      }

      const factor = factorsData?.totp?.[0] ?? factorsData?.phone?.[0];
      if (!factor) {
        toast({
          title: "MFA required",
          description: "No enrolled MFA factor was found on this account.",
          variant: "destructive",
        });
        return;
      }

      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: factor.id,
      });
      if (challengeError || !challengeData) {
        toast({
          title: "MFA challenge failed",
          description: challengeError?.message ?? "Unable to start MFA challenge.",
          variant: "destructive",
        });
        return;
      }

      setMfaFactorId(factor.id);
      setMfaChallengeId(challengeData.id);
      setMfaPending(true);
      toast({
        title: "MFA required",
        description: "Enter your authentication code to finish signing in.",
      });
      return;
    }

    if (rememberMe) localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
    else localStorage.removeItem(REMEMBER_EMAIL_KEY);

    toast({ title: "Signed in", description: role ? `Role detected: ${role}` : "Redirecting to dashboard." });
    navigate("/dashboard");
  };

  const verifyMfa = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mfaFactorId || !mfaChallengeId) return;

    setSubmitting(true);
    const { error } = await supabase.auth.mfa.verify({
      factorId: mfaFactorId,
      challengeId: mfaChallengeId,
      code: mfaCode.trim(),
    });
    setSubmitting(false);

    if (error) {
      toast({
        title: "Invalid MFA code",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    if (rememberMe) localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
    else localStorage.removeItem(REMEMBER_EMAIL_KEY);

    navigate("/dashboard");
  };

  const handleGoogleSignIn = async () => {
    const { error } = await signInWithGoogle();
    if (error) {
      toast({
        title: "Google sign-in failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  return (
    <AuthSplitLayout title="Welcome back" subtitle="Sign in to manage your OpsAI workspace.">
      {!mfaPending ? (
        <>
          <motion.form
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24 }}
            onSubmit={handleSubmit}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="email">Work Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center gap-2 text-slate-600">
                <Checkbox
                  checked={rememberMe}
                  onCheckedChange={(checked) => setRememberMe(Boolean(checked))}
                  aria-label="Remember me"
                />
                Remember me
              </label>
              <Link to="/auth/forgot-password" className="font-medium text-violet-700 hover:text-violet-800">
                Forgot password?
              </Link>
            </div>

            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Log In"
              )}
            </Button>
          </motion.form>

          <div className="my-6 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Or continue with</span>
            <Separator className="flex-1" />
          </div>

          <Button type="button" variant="outline" className="w-full" onClick={handleGoogleSignIn}>
            <GoogleIcon />
            Continue with Google
          </Button>
        </>
      ) : (
        <motion.form
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24 }}
          onSubmit={verifyMfa}
          className="space-y-4"
        >
          <p className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-700">
            Multi-factor authentication is enabled. Enter your one-time code to continue.
          </p>
          <div className="space-y-2">
            <Label htmlFor="mfa-code">Verification code</Label>
            <Input
              id="mfa-code"
              placeholder="123456"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              required
              inputMode="numeric"
            />
          </div>
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              "Verify code"
            )}
          </Button>
        </motion.form>
      )}

      <p className="mt-6 text-center text-sm text-slate-600">
        New to OpsAI?{" "}
        <Link to="/auth/signup" className="font-semibold text-violet-700 hover:text-violet-800">
          Create account
        </Link>
      </p>
    </AuthSplitLayout>
  );
}
