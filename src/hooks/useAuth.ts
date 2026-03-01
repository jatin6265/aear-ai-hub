import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";

type SignUpInput = {
  email: string;
  password: string;
  fullName: string;
  companyName: string;
  termsAccepted: boolean;
};

type SignInResult = {
  error: Error | null;
  role: string | null;
};

type AuthContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signUp: (input: SignUpInput) => Promise<{
    error: Error | null;
    requiresEmailVerification: boolean;
    provisioningError: Error | null;
  }>;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  resendVerificationEmail: (email: string) => Promise<{ error: Error | null }>;
  sendPasswordResetEmail: (email: string) => Promise<{ error: Error | null }>;
  updatePassword: (password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<{ error: Error | null }>;
  emailVerified: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isUserEmailVerified(user: User | null) {
  if (!user) return false;

  const confirmedAt =
    (user as unknown as { email_confirmed_at?: string | null }).email_confirmed_at ??
    (user as unknown as { confirmed_at?: string | null }).confirmed_at ??
    null;

  return typeof confirmedAt === "string" && confirmedAt.length > 0;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasProjectTokenMismatch(token: string) {
  const payload = decodeJwtPayload(token);
  const issuer = typeof payload?.iss === "string" ? payload.iss : "";
  const expected = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1`;
  // Only flag a mismatch if both values are non-empty and they genuinely disagree
  if (!issuer || !expected || expected === "/auth/v1") return false;
  return !issuer.startsWith(expected);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const emailVerified = useMemo(() => isUserEmailVerified(user), [user]);

  const touchLastActive = useCallback(async (activeUser: User | null) => {
    if (!activeUser) return;
    await supabase
      .from("profiles")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", activeUser.id);
  }, []);

  const applySession = useCallback(
    (nextSession: Session | null, nextUser: User | null) => {
      setSession(nextSession);
      setUser(nextUser);
      void touchLastActive(nextUser);
    },
    [touchLastActive],
  );

  // ─── Auth state listener ──────────────────────────────────────────────────
  // We trust Supabase's own session management entirely.
  // autoRefreshToken:true in the client config handles token renewal.
  // We only clear the session ourselves when the token is from a different
  // Supabase project (a stale localStorage entry from a previous environment).
  // NO extra getUser() network call, NO refreshSession() call — these caused
  // a race condition that cleared valid sessions milliseconds after login and
  // made all subsequent Supabase DB queries return 401 "Authentication required".
  useEffect(() => {
    let active = true;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;

      if (!nextSession) {
        applySession(null, null);
        setLoading(false);
        return;
      }

      // Guard: stale token from a different Supabase project in localStorage
      if (nextSession.access_token && hasProjectTokenMismatch(nextSession.access_token)) {
        void supabase.auth.signOut({ scope: "local" });
        applySession(null, null);
        setLoading(false);
        return;
      }

      applySession(nextSession, nextSession.user ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [applySession]);

  // ─── signUp ───────────────────────────────────────────────────────────────
  const signUp = async ({ email, password, fullName, companyName, termsAccepted }: SignUpInput) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          company_name: companyName,
          terms_accepted: termsAccepted,
        },
        emailRedirectTo: `${window.location.origin}/auth/confirm-email`,
      },
    });

    if (error) {
      return { error, requiresEmailVerification: false, provisioningError: null };
    }

    const verified = isUserEmailVerified(data.user ?? null);
    if (!verified && data.session) {
      await supabase.auth.signOut({ scope: "local" });
    }

    let provisioningError: Error | null = null;
    if (data.user) {
      if (data.session && verified) {
        try {
          await ensureUserWorkspace(data.user, { fullName, companyName, termsAccepted });
        } catch (workspaceError) {
          provisioningError =
            workspaceError instanceof Error
              ? workspaceError
              : new Error("Workspace setup is pending until verification.");
        }
      } else {
        provisioningError = new Error("Workspace setup will complete after email verification.");
      }
    }

    return {
      error: null,
      requiresEmailVerification: !verified,
      provisioningError,
    };
  };

  // ─── signIn ───────────────────────────────────────────────────────────────
  // Deliberately does NOT call ensureUserWorkspace — workspace provisioning
  // happens lazily in OnboardingGuard and dashboard pages.  Calling it here
  // was blocking login whenever the RPC was missing or the DB was slow, and
  // showing "Unable to sign in" even when the user was fully authenticated.
  const signIn = async (email: string, password: string): Promise<SignInResult> => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error, role: null };
    if (!data.user) return { error: new Error("No user returned from sign-in."), role: null };

    if (!isUserEmailVerified(data.user)) {
      await supabase.auth.signOut({ scope: "local" });
      return {
        error: new Error("Email not verified. Please check your inbox and verify before signing in."),
        role: null,
      };
    }

    // Role is set lazily — return what we know without an extra DB round-trip
    const role =
      typeof data.user.user_metadata?.role === "string" ? data.user.user_metadata.role : null;
    return { error: null, role };
  };

  // ─── signInWithGoogle ─────────────────────────────────────────────────────
  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });
    return { error };
  };

  // ─── email helpers ────────────────────────────────────────────────────────
  const resendVerificationEmail = async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm-email`,
      },
    });
    return { error };
  };

  const sendPasswordResetEmail = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    return { error };
  };

  const updatePassword = async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    return { error };
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
  };

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      signUp,
      signIn,
      signInWithGoogle,
      resendVerificationEmail,
      sendPasswordResetEmail,
      updatePassword,
      signOut,
      emailVerified,
    }),
    [user, session, loading, emailVerified],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
