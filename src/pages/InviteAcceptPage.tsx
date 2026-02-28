import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, LogOut, MailWarning, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PasswordStrengthMeter from "@/components/auth/PasswordStrengthMeter";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type InviteData = {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string | null;
  sentAt: string | null;
};

type InviteLookupResult = {
  valid: boolean;
  reason?: string;
  invitation?: InviteData;
  status?: string;
};

type RpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

type RpcInvoker = {
  rpc: (fn: string, params?: Record<string, unknown>) => Promise<RpcResult>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

function normalizeLookup(value: unknown): InviteLookupResult {
  const row = asRecord(value);
  if (!row) return { valid: false, reason: "invalid" };

  const invitationRaw = asRecord(row.invitation);
  let invitation: InviteData | undefined;

  if (invitationRaw) {
    invitation = {
      id: String(invitationRaw.id ?? ""),
      tenantId: String(invitationRaw.tenantId ?? ""),
      tenantName: String(invitationRaw.tenantName ?? "Workspace"),
      email: String(invitationRaw.email ?? "").toLowerCase(),
      role: String(invitationRaw.role ?? "member"),
      status: String(invitationRaw.status ?? "sent"),
      expiresAt: invitationRaw.expiresAt ? String(invitationRaw.expiresAt) : null,
      sentAt: invitationRaw.sentAt ? String(invitationRaw.sentAt) : null,
    };
  }

  return {
    valid: Boolean(row.valid),
    reason: row.reason ? String(row.reason) : undefined,
    status: row.status ? String(row.status) : undefined,
    invitation,
  };
}

export default function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get("token")?.trim() ?? "", [searchParams]);

  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading, signOut } = useAuth();

  const [inviteLoading, setInviteLoading] = useState(true);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<InviteData | null>(null);

  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [autoAcceptAttempted, setAutoAcceptAttempted] = useState(false);
  const rpcClient = supabase as unknown as RpcInvoker;

  const lookupInvitation = useCallback(async () => {
    if (!token) {
      setInviteError("Missing invitation token.");
      setInviteLoading(false);
      return;
    }

    setInviteLoading(true);
    setInviteError(null);

    try {
      const { data, error } = await rpcClient.rpc("get_team_invitation_by_token", {
        p_token: token,
      });

      if (error) throw error;

      const result = normalizeLookup(data);
      if (!result.valid || !result.invitation) {
        if (result.reason === "expired") {
          setInviteError("This invitation has expired.");
        } else if (result.reason === "already_used") {
          setInviteError("This invitation has already been used.");
        } else {
          setInviteError("Invitation link is invalid.");
        }
        setInvitation(null);
      } else {
        setInvitation(result.invitation);
      }
    } catch (error) {
      setInviteError(normalizeError(error));
      setInvitation(null);
    } finally {
      setInviteLoading(false);
    }
  }, [rpcClient, token]);

  useEffect(() => {
    void lookupInvitation();
  }, [lookupInvitation]);

  const acceptWithCurrentSession = useCallback(
    async (nameOverride?: string) => {
      if (!token) throw new Error("Invitation token missing");

      const { data, error } = await rpcClient.rpc("accept_team_invitation_token", {
        p_token: token,
        p_full_name: (nameOverride ?? "").trim() || null,
      });

      if (error) throw error;

      setAccepted(true);
      toast({
        title: "Invitation accepted",
        description: "Welcome to your workspace.",
      });

      window.setTimeout(() => {
        navigate("/dashboard", { replace: true });
      }, 1600);

      return data;
    },
    [navigate, rpcClient, toast, token],
  );

  const handleCreateAndAccept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!invitation) return;

    if (!fullName.trim()) {
      toast({
        title: "Full name required",
        description: "Please provide your full name.",
        variant: "destructive",
      });
      return;
    }

    if (password.length < 8) {
      toast({
        title: "Password too short",
        description: "Use at least 8 characters.",
        variant: "destructive",
      });
      return;
    }

    if (password !== confirmPassword) {
      toast({
        title: "Passwords do not match",
        description: "Please enter matching passwords.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: invitation.email,
        password,
        options: {
          data: {
            full_name: fullName.trim(),
          },
          emailRedirectTo: `${window.location.origin}/invite/accept?token=${encodeURIComponent(token)}`,
        },
      });

      if (error) {
        throw error;
      }

      if (!data.session) {
        setAwaitingVerification(true);
        toast({
          title: "Check your email",
          description: "Confirm your account and reopen this invite link to join the workspace.",
        });
        return;
      }

      await acceptWithCurrentSession(fullName.trim());
    } catch (error) {
      toast({
        title: "Could not accept invitation",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleAcceptExisting = async () => {
    setSubmitting(true);
    try {
      await acceptWithCurrentSession();
    } catch (error) {
      toast({
        title: "Could not accept invitation",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const userEmail = user?.email?.toLowerCase() ?? null;
  const loggedInDifferentAccount = Boolean(userEmail && invitation?.email && userEmail !== invitation.email.toLowerCase());

  useEffect(() => {
    if (inviteLoading || loading || accepted || submitting || awaitingVerification) return;
    if (!user || !invitation) return;
    if (loggedInDifferentAccount) return;
    if (autoAcceptAttempted) return;

    setAutoAcceptAttempted(true);
    setSubmitting(true);
    void acceptWithCurrentSession()
      .catch((error) => {
        toast({
          title: "Could not accept invitation",
          description: normalizeError(error),
          variant: "destructive",
        });
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [
    acceptWithCurrentSession,
    accepted,
    autoAcceptAttempted,
    awaitingVerification,
    invitation,
    inviteLoading,
    loading,
    loggedInDifferentAccount,
    submitting,
    toast,
    user,
  ]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/70">
        {inviteLoading || loading ? (
          <div className="space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Validating invitation</h1>
            <p className="text-sm text-slate-600">Please wait while we verify your invitation token.</p>
          </div>
        ) : inviteError || !invitation ? (
          <div className="space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-rose-100 text-rose-700">
              <MailWarning className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Invitation unavailable</h1>
            <p className="text-sm text-slate-600">{inviteError ?? "This invitation is invalid."}</p>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/auth/login"
                className="inline-flex rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
              >
                Go to login
              </Link>
            </div>
          </div>
        ) : accepted ? (
          <div className="space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Welcome to {invitation.tenantName}</h1>
            <p className="text-sm text-slate-600">Your invitation has been accepted. Redirecting to dashboard...</p>
          </div>
        ) : (
          <div className="space-y-5">
            <header className="space-y-1">
              <h1 className="text-2xl font-bold text-slate-900">You&apos;ve been invited to join {invitation.tenantName} on OpsAI</h1>
              <p className="text-sm text-slate-600">
                Invite for <span className="font-medium text-slate-800">{invitation.email}</span> as {invitation.role}.
              </p>
            </header>

            {loggedInDifferentAccount ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <p className="font-medium">You&apos;re logged in as {userEmail}.</p>
                  <p className="mt-1">Log out first to accept this invitation with {invitation.email}.</p>
                </div>
                <Button
                  variant="outline"
                  className="border-amber-300 text-amber-800 hover:bg-amber-100"
                  onClick={() => void signOut()}
                >
                  <LogOut className="h-4 w-4" />
                  Log out and continue
                </Button>
              </div>
            ) : user ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                  Logged in as {userEmail}. Click below to join this workspace.
                </div>
                <Button
                  className="w-full bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
                  disabled={submitting}
                  onClick={() => void handleAcceptExisting()}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Accept Invitation
                </Button>
              </div>
            ) : awaitingVerification ? (
              <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
                <p className="font-medium">Check your inbox to confirm your account.</p>
                <p>After email confirmation, reopen this invite link to complete joining {invitation.tenantName}.</p>
              </div>
            ) : (
              <form onSubmit={handleCreateAndAccept} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="invite-full-name">Full Name</Label>
                  <Input
                    id="invite-full-name"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    placeholder="Jane Doe"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input id="invite-email" value={invitation.email} disabled readOnly />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="invite-password">Password</Label>
                  <Input
                    id="invite-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Create a password"
                    minLength={8}
                    required
                  />
                  <PasswordStrengthMeter password={password} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="invite-confirm-password">Confirm Password</Label>
                  <Input
                    id="invite-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Confirm password"
                    required
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
                  disabled={submitting}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Accept Invitation
                </Button>
              </form>
            )}

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 text-slate-500" />
                <p>
                  Invitation links are single-use and tied to the invited email. If this link is expired, ask your admin to resend.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
