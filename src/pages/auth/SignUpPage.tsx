import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import AuthSplitLayout from "@/components/auth/AuthSplitLayout";
import GoogleIcon from "@/components/auth/GoogleIcon";
import PasswordStrengthMeter from "@/components/auth/PasswordStrengthMeter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

export default function SignUpPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { signUp, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password !== confirmPassword) {
      toast({
        title: "Passwords do not match",
        description: "Please make sure both password fields are identical.",
        variant: "destructive",
      });
      return;
    }

    if (!acceptedTerms) {
      toast({
        title: "Accept terms to continue",
        description: "Please accept the Terms and Privacy Policy.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    const { error, provisioningError } = await signUp({
      fullName: fullName.trim(),
      email: email.trim(),
      companyName: companyName.trim(),
      password,
      termsAccepted: acceptedTerms,
    });
    setSubmitting(false);

    if (error) {
      toast({
        title: "Sign-up failed",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    if (provisioningError) {
      toast({
        title: "Account created",
        description: "Email verification is required. Workspace setup will complete after verification.",
      });
    }

    navigate(`/auth/verify-email?email=${encodeURIComponent(email.trim())}`);
  };

  const handleGoogleSignIn = async () => {
    const { error } = await signInWithGoogle();
    if (error) {
      toast({
        title: "Google sign-up failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  return (
    <AuthSplitLayout title="Create your workspace" subtitle="Set up AEAR for your organization in minutes.">
      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24 }}
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="fullName">Full Name</Label>
          <Input
            id="fullName"
            autoComplete="name"
            placeholder="Jane Doe"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="workEmail">Work Email</Label>
          <Input
            id="workEmail"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="companyName">Company Name</Label>
          <Input
            id="companyName"
            autoComplete="organization"
            placeholder="Acme Inc."
            value={companyName}
            onChange={(event) => setCompanyName(event.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="Create a password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
          />
          <PasswordStrengthMeter password={password} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm Password</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-600">
          <Checkbox
            checked={acceptedTerms}
            onCheckedChange={(checked) => setAcceptedTerms(Boolean(checked))}
            aria-label="Accept terms and privacy policy"
            className="mt-0.5"
          />
          <span>
            By signing up you agree to{" "}
            <Link to="/legal/terms" className="font-medium text-violet-700 hover:text-violet-800">
              Terms
            </Link>{" "}
            &{" "}
            <Link to="/legal/privacy" className="font-medium text-violet-700 hover:text-violet-800">
              Privacy
            </Link>
            .
          </span>
        </label>

        <Button
          type="submit"
          className="w-full bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
          disabled={submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating account...
            </>
          ) : (
            "Create Account"
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
        Sign up with Google
      </Button>

      <p className="mt-6 text-center text-sm text-slate-600">
        Already have an account?{" "}
        <Link to="/auth/login" className="font-semibold text-violet-700 hover:text-violet-800">
          Log in
        </Link>
      </p>
    </AuthSplitLayout>
  );
}
