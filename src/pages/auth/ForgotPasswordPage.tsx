import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import AuthSplitLayout from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const { sendPasswordResetEmail } = useAuth();
  const { toast } = useToast();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);

    const { error } = await sendPasswordResetEmail(email.trim());
    setSubmitting(false);

    if (error) {
      toast({
        title: "Unable to send reset link",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setSent(true);
    toast({
      title: "Reset email sent",
      description: "Open the email link to set your new password.",
    });
  };

  return (
    <AuthSplitLayout title="Forgot password?" subtitle="We'll send you a secure link to reset your password.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="forgot-email">Work Email</Label>
          <Input
            id="forgot-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            required
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
              Sending...
            </>
          ) : (
            "Send reset link"
          )}
        </Button>

        {sent && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Reset instructions sent. Check your email inbox.
          </p>
        )}
      </form>

      <p className="mt-6 text-center text-sm text-slate-600">
        Remember your password?{" "}
        <Link to="/auth/login" className="font-semibold text-violet-700 hover:text-violet-800">
          Back to login
        </Link>
      </p>
    </AuthSplitLayout>
  );
}
