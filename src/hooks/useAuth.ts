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
  if (!issuer || !expected) return false;
  return !issuer.startsWith(expected);
}

function isHardRefreshFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown })?.status ?? 0);
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  if (status === 401) return true;
  return (
    message.includes("invalid refresh token") ||
    message.includes("refresh token not found") ||
    message.includes("token has expired") ||
    message.includes("jwt expired")
  );
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
      .update({
        last_active_at: new Date().toISOString(),
      })
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

  const resolveValidSession = useCallback(
    async (candidateSession: Session | null, allowRefresh = true) => {
      if (!candidateSession) {
        applySession(null, null);
        return;
      }

      let activeSession: Session | null = candidateSession;
      if (candidateSession.access_token && hasProjectTokenMismatch(candidateSession.access_token)) {
        await supabase.auth.signOut({ scope: "local" });
        applySession(null, null);
        return;
      }
      const tokenExpiresSoon =
        !candidateSession.expires_at || candidateSession.expires_at * 1000 <= Date.now() + 60_000;
      if (allowRefresh && tokenExpiresSoon) {
        const refreshed = await supabase.auth.refreshSession();
        if (isHardRefreshFailure(refreshed.error)) {
          await supabase.auth.signOut({ scope: "local" });
          applySession(null, null);
          return;
        }
        activeSession = refreshed.data.session ?? null;
      }

      if (!activeSession) {
        applySession(null, null);
        return;
      }
      if (activeSession.access_token && hasProjectTokenMismatch(activeSession.access_token)) {
        await supabase.auth.signOut({ scope: "local" });
        applySession(null, null);
        return;
      }

      applySession(activeSession, activeSession.user ?? candidateSession.user ?? null);

      const userResult = await supabase.auth.getUser(activeSession.access_token);
      if (userResult.error || !userResult.data.user) {
        const status = (userResult.error as { status?: number } | null | undefined)?.status;
        const message = String(userResult.error?.message ?? "").toLowerCase();
        const definitelyExpired =
          message.includes("jwt expired") ||
          message.includes("token is expired") ||
          message.includes("invalid refresh token") ||
          message.includes("refresh token");
        const invalidSession =
          definitelyExpired ||
          (status === 401 &&
            (message.includes("invalid jwt") || message.includes("expired")));

        if (invalidSession) {
          await supabase.auth.signOut({ scope: "local" });
          applySession(null, null);
        }
        // Keep existing session state for transient network issues.
        return;
      }

      applySession(activeSession, userResult.data.user);
    },
    [applySession],
  );

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
      applySession(nextSession, nextSession.user ?? null);
      setLoading(false);
      void resolveValidSession(nextSession, true);
    });

    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      await resolveValidSession(data.session ?? null, true);
      if (active) setLoading(false);
    })();

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [applySession, resolveValidSession]);

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

  const signIn = async (email: string, password: string): Promise<SignInResult> => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error, role: null };
    if (!data.user) return { error: new Error("No user in session."), role: null };
    if (!isUserEmailVerified(data.user)) {
      await supabase.auth.signOut({ scope: "local" });
      return {
        error: new Error("Email not verified. Please verify your email before signing in."),
        role: null,
      };
    }

    try {
      const profile = await ensureUserWorkspace(data.user);
      return { error: null, role: profile.role };
    } catch (workspaceError) {
      return {
        error: workspaceError instanceof Error ? workspaceError : new Error("Unable to load profile."),
        role: null,
      };
    }
  };

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });
    return { error };
  };

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
    [
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
    ],
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
