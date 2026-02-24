import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Bot,
  Building2,
  Braces,
  Check,
  CloudUpload,
  DatabaseZap,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Link2,
  Loader2,
  NotebookPen,
  PlugZap,
  Plus,
  Rocket,
  Sheet,
  Sparkles,
  UserPlus2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import {
  formatEdgeFunctionError,
  isSessionExpiredMessage,
  sanitizeConnectionErrorMessage,
} from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { ensureActiveUserSession } from "@/lib/session";

type StepId = 1 | 2 | 3 | 4;

const STEP_CONFIG = [
  { id: 1 as StepId, label: "Company", icon: Building2 },
  { id: 2 as StepId, label: "Team", icon: Users },
  { id: 3 as StepId, label: "Connect Data", icon: DatabaseZap },
  { id: 4 as StepId, label: "Launch", icon: Rocket },
];

const INDUSTRIES = [
  "Technology",
  "Manufacturing",
  "Retail",
  "Healthcare",
  "Finance",
  "Services",
  "Other",
] as const;

const SIZE_OPTIONS = ["1-10", "11-50", "51-200", "201-500", "500+"] as const;

const USE_CASES = [
  "Internal Assistant",
  "ERP Intelligence",
  "Customer Support AI",
  "Operations AI",
] as const;

const REGIONS = ["US East", "EU West", "Asia Pacific", "India"] as const;
const TEAM_ROLES = ["Admin", "Manager", "Member", "Viewer"] as const;
const STARTER_INVITE_LIMIT = 5;

type ConnectionType =
  | "rest_openapi"
  | "postgresql"
  | "mysql"
  | "mongodb"
  | "google_sheets"
  | "notion"
  | "custom_rest";

const CONNECTION_OPTIONS: Array<{
  value: ConnectionType;
  title: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { value: "rest_openapi", title: "REST API", subtitle: "OpenAPI/Swagger", icon: Braces },
  { value: "postgresql", title: "PostgreSQL Database", subtitle: "Structured relational", icon: DatabaseZap },
  { value: "mysql", title: "MySQL Database", subtitle: "Operational SQL", icon: DatabaseZap },
  { value: "mongodb", title: "MongoDB", subtitle: "Document database", icon: PlugZap },
  { value: "google_sheets", title: "Google Sheets", subtitle: "Spreadsheet source", icon: Sheet },
  { value: "notion", title: "Notion", subtitle: "Workspace database", icon: NotebookPen },
  { value: "custom_rest", title: "Custom REST API", subtitle: "No spec provided", icon: Link2 },
];

type TeamInviteDraft = {
  email: string;
  role: (typeof TEAM_ROLES)[number];
};

type TestOutcome = {
  status: "idle" | "success" | "error";
  message: string;
};

type ConnectionValidation =
  | { error: string }
  | {
      name: string;
      baseUrl: string;
      authType: "none" | "api_key";
      config: Record<string, unknown>;
      testPayload: Record<string, unknown>;
    };

type SummaryConnection = {
  id: string;
  name: string;
};

type SummaryMember = {
  id: string;
  label: string;
  avatarUrl: string | null;
};

type SummaryAgent = {
  id: string;
  name: string;
  status: string;
};

type LaunchPipelineStatus = {
  schema: string;
  rag: string;
  email: string;
};

type RaciSuggestion = {
  id: string;
  summary: string;
  enabled: boolean;
  resource: string;
  action: string;
  responsibleRole: string;
  accountableRole: string;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "Please try again.";
}

function isMissingTenantFieldError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message.toLowerCase()
      : "";
  if (code === "42703" || code === "PGRST204") return true;
  return message.includes("column") && message.includes("tenants");
}

function isMissingInvitationFieldError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message.toLowerCase()
      : "";
  if (code === "42703" || code === "PGRST204") return true;
  return message.includes("column") && message.includes("team_invitations");
}

function isMissingEdgeFunctionError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message.toLowerCase()
      : "";
  return (
    message.includes("failed to send a request") ||
    message.includes("failed to fetch") ||
    message.includes("non-2xx") ||
    message.includes("not found") ||
    message.includes("404")
  );
}

function detailsToMessageSuffix(details: unknown) {
  if (!details || typeof details !== "object") return "";
  const safeDetails = details as Record<string, unknown>;
  const extras: string[] = [];
  if (typeof safeDetails.tcpMessage === "string" && safeDetails.tcpMessage.trim()) {
    extras.push(`Network: ${safeDetails.tcpMessage.trim()}`);
  }
  if (typeof safeDetails.host === "string" && safeDetails.host.trim()) {
    extras.push(`Host: ${safeDetails.host.trim()}`);
  }
  if (typeof safeDetails.port === "number" && Number.isFinite(safeDetails.port)) {
    extras.push(`Port: ${safeDetails.port}`);
  }
  if (typeof safeDetails.statusCode === "number" && Number.isFinite(safeDetails.statusCode)) {
    extras.push(`Status code: ${safeDetails.statusCode}`);
  }
  return extras.length > 0 ? ` ${extras.join(" · ")}` : "";
}

function isConnectionLimitReachedMessage(message: string) {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("connection limit reached") ||
    normalized.includes("plan limit reached") ||
    normalized.includes("maximum connections") ||
    normalized.includes("max connections")
  );
}

const REGION_DB_MAP: Record<(typeof REGIONS)[number], string> = {
  "US East": "us-east",
  "EU West": "eu-west",
  "Asia Pacific": "asia-pacific",
  India: "india",
};

const REGION_UI_MAP: Record<string, (typeof REGIONS)[number]> = {
  "us-east": "US East",
  "eu-west": "EU West",
  "asia-pacific": "Asia Pacific",
  india: "India",
};

function toRegionDbValue(regionLabel: string) {
  return REGION_DB_MAP[regionLabel as (typeof REGIONS)[number]] ?? regionLabel;
}

function toRegionUiValue(storedRegion: string) {
  const normalized = storedRegion.trim().toLowerCase();
  return REGION_UI_MAP[normalized] ?? (REGIONS.includes(storedRegion as (typeof REGIONS)[number]) ? (storedRegion as (typeof REGIONS)[number]) : "US East");
}

export default function Onboarding() {
  const [currentStep, setCurrentStep] = useState<StepId>(1);
  const [maxCompletedStep, setMaxCompletedStep] = useState(0);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [savingCompany, setSavingCompany] = useState(false);

  const [companyLogoPreview, setCompanyLogoPreview] = useState<string | null>(null);
  const [draggingLogo, setDraggingLogo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const serviceAccountInputRef = useRef<HTMLInputElement | null>(null);

  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [primaryUseCase, setPrimaryUseCase] = useState("");
  const [defaultRegion, setDefaultRegion] = useState("US East");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<(typeof TEAM_ROLES)[number]>("Member");
  const [teamInvites, setTeamInvites] = useState<TeamInviteDraft[]>([]);
  const [sendingInvites, setSendingInvites] = useState(false);
  const [selectedConnectionType, setSelectedConnectionType] = useState<ConnectionType | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome>({ status: "idle", message: "" });
  const [savingDataConnection, setSavingDataConnection] = useState(false);
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState(
    "Background schema analysis is being queued.",
  );
  const [connectionAdded, setConnectionAdded] = useState(false);
  const [savedConnectionId, setSavedConnectionId] = useState<string | null>(null);
  const [connectedSources, setConnectedSources] = useState<SummaryConnection[]>([]);
  const [teamMembers, setTeamMembers] = useState<SummaryMember[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<SummaryAgent[]>([]);
  const [launchPipelineStatus, setLaunchPipelineStatus] = useState<LaunchPipelineStatus>({
    schema: "Schema detection status is being checked...",
    rag: "RAG indexing status is being checked...",
    email: "You’ll get an email when RAG is ready.",
  });
  const [loadingLaunchSummary, setLoadingLaunchSummary] = useState(false);
  const [launchingDestination, setLaunchingDestination] = useState<"dashboard" | "raci" | null>(null);
  const [showConfettiFallback, setShowConfettiFallback] = useState(false);
  const launchSyncKickoffRef = useRef(false);
  const launchSummaryPollingRef = useRef<number | null>(null);
  const launchAutoRegenerateRef = useRef(false);
  const [raciSuggestions, setRaciSuggestions] = useState<RaciSuggestion[]>([
    {
      id: "finance-rule",
      summary: "Finance data -> Finance Manager is Responsible, CFO is Accountable",
      enabled: true,
      resource: "Finance data",
      action: "approve_changes",
      responsibleRole: "Finance Manager",
      accountableRole: "CFO",
    },
    {
      id: "ops-rule",
      summary: "Operations data -> Ops Lead is Responsible, COO is Accountable",
      enabled: true,
      resource: "Operations data",
      action: "execute_workflows",
      responsibleRole: "Ops Lead",
      accountableRole: "COO",
    },
    {
      id: "analytics-rule",
      summary: "Analytics exports -> Analyst is Responsible, Data Director is Accountable",
      enabled: true,
      resource: "Analytics exports",
      action: "publish_reports",
      responsibleRole: "Analyst",
      accountableRole: "Data Director",
    },
  ]);

  const [restForm, setRestForm] = useState({ name: "", baseUrl: "", apiKey: "", specUrl: "" });
  const [sqlForm, setSqlForm] = useState({
    name: "",
    host: "",
    port: "",
    database: "",
    username: "",
    password: "",
    ssl: true,
  });
  const [mongoForm, setMongoForm] = useState({ name: "", connectionString: "" });
  const [sheetsForm, setSheetsForm] = useState({
    name: "",
    sheetUrl: "",
    serviceAccountFileName: "",
    serviceAccountJson: "",
  });
  const [notionForm, setNotionForm] = useState({ name: "", integrationToken: "", databaseId: "" });
  const [customRestForm, setCustomRestForm] = useState({ name: "", baseUrl: "", apiKey: "" });

  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({
    restApiKey: false,
    sqlPassword: false,
    mongoConn: false,
    notionToken: false,
    customApiKey: false,
  });

  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const confettiFiredRef = useRef(false);
  const ensureActiveSession = useCallback(async () => {
    return ensureActiveUserSession();
  }, []);

  const metaCompanyName = useMemo(() => {
    const raw = user?.user_metadata?.company_name;
    return typeof raw === "string" ? raw : "";
  }, [user?.user_metadata]);

  useEffect(() => {
    let active = true;

    const loadOnboardingData = async () => {
      if (!user) {
        if (!active) return;
        toast({
          title: "Session expired",
          description: "Please sign in again to continue onboarding.",
          variant: "destructive",
        });
        navigate("/auth/login", { replace: true });
        return;
      }
      const activeSession = await ensureActiveSession();
      if (!activeSession) {
        if (!active) return;
        toast({
          title: "Session expired",
          description: "Please sign in again to continue onboarding.",
          variant: "destructive",
        });
        navigate("/auth/login", { replace: true });
        return;
      }
      try {
        const workspace = await ensureUserWorkspace(user, {
          companyName: metaCompanyName || undefined,
          fullName:
            typeof user.user_metadata?.full_name === "string"
              ? user.user_metadata.full_name
              : undefined,
        });
        if (!active) return;
        setTenantId(workspace.tenantId);

        const { data, error } = await supabase
          .from("tenants")
          .select("*")
          .eq("id", workspace.tenantId)
          .single();

        if (error) throw error;
        if (!active) return;

        const tenant = (data ?? {}) as Record<string, unknown>;
        const existingName =
          typeof tenant.name === "string" && tenant.name ? tenant.name : "";
        const existingRegion =
          typeof tenant.region === "string" && tenant.region ? tenant.region : "";
        const existingIndustry =
          typeof tenant.industry === "string" ? tenant.industry : "";
        const existingCompanySize =
          typeof tenant.company_size === "string" ? tenant.company_size : "";
        const existingUseCase =
          typeof tenant.primary_use_case === "string" ? tenant.primary_use_case : "";
        const existingLogo =
          typeof tenant.logo_url === "string" ? tenant.logo_url : null;

        setCompanyName(existingName || metaCompanyName || "");
        setDefaultRegion(toRegionUiValue(existingRegion));
        setIndustry(existingIndustry);
        setCompanySize(existingCompanySize);
        setPrimaryUseCase(existingUseCase);
        setCompanyLogoPreview(existingLogo);
      } catch (error) {
        if (!active) return;
        setCompanyName(metaCompanyName || "");
        toast({
          title: "Could not load onboarding profile",
          description: error instanceof Error ? error.message : "Please fill the form manually.",
          variant: "destructive",
        });
      } finally {
        if (active) setLoadingProfile(false);
      }
    };

    void loadOnboardingData();

    return () => {
      active = false;
    };
  }, [ensureActiveSession, metaCompanyName, navigate, toast, user]);

  useEffect(() => {
    setTestOutcome({ status: "idle", message: "" });
    setAnalysisVisible(false);
    setConnectionAdded(false);
    setSavedConnectionId(null);
    setAnalysisMessage("Background schema analysis is being queued.");
  }, [selectedConnectionType]);

  const markStepComplete = (step: StepId) => {
    setMaxCompletedStep((prev) => Math.max(prev, step));
  };

  const handleLogoFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({
        title: "Unsupported file",
        description: "Please upload an image file for your company logo.",
        variant: "destructive",
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setCompanyLogoPreview(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleCompanyContinue = async () => {
    if (!companyName.trim() || !industry || !companySize || !primaryUseCase || !defaultRegion) {
      toast({
        title: "Complete required fields",
        description: "Please fill all company setup fields before continuing.",
        variant: "destructive",
      });
      return;
    }

    const activeSession = await ensureActiveSession();
    if (!user || !activeSession) {
      toast({
        title: "Session expired",
        description: "Please sign in again to continue onboarding.",
        variant: "destructive",
      });
      navigate("/auth/login", { replace: true });
      return;
    }
    setSavingCompany(true);

    try {
      const payload = {
        name: companyName.trim(),
        region: toRegionDbValue(defaultRegion),
        industry,
        company_size: companySize,
        primary_use_case: primaryUseCase,
        logo_url: companyLogoPreview,
      };

      const saveCompanyViaClientFallback = async () => {
        const workspace = await ensureUserWorkspace(user, { companyName: payload.name });
        const resolvedTenantId = tenantId || workspace.tenantId;
        if (!resolvedTenantId) throw new Error("Could not resolve workspace tenant.");
        if (!tenantId) setTenantId(resolvedTenantId);

        const fullUpdate = await supabase
          .from("tenants")
          .update({
            name: payload.name,
            region: payload.region,
            industry: payload.industry,
            company_size: payload.company_size,
            primary_use_case: payload.primary_use_case,
            logo_url: payload.logo_url,
            onboarding_step: 2,
          })
          .eq("id", resolvedTenantId)
          .select("id")
          .maybeSingle();

        if (!fullUpdate.error) return;

        if (!isMissingTenantFieldError(fullUpdate.error)) {
          throw fullUpdate.error;
        }

        const minimalUpdate = await supabase
          .from("tenants")
          .update({
            name: payload.name,
            region: payload.region,
            onboarding_step: 2,
          })
          .eq("id", resolvedTenantId)
          .select("id")
          .maybeSingle();

        if (minimalUpdate.error) throw minimalUpdate.error;
      };

      const edgeSave = await invokeEdge("onboarding-company-setup", {
        body: {
          name: payload.name,
          region: payload.region,
          industry: payload.industry,
          companySize: payload.company_size,
          primaryUseCase: payload.primary_use_case,
          logoUrl: payload.logo_url,
        },
      });

      if (!edgeSave.error) {
        const resolvedTenantId =
          edgeSave.data && typeof edgeSave.data === "object" && "tenantId" in edgeSave.data
            ? String((edgeSave.data as { tenantId?: unknown }).tenantId ?? "")
            : "";
        if (!tenantId && resolvedTenantId) setTenantId(resolvedTenantId);
        markStepComplete(1);
        setCurrentStep(2);
        return;
      }

      const edgeMessage = await formatEdgeFunctionError(edgeSave.error, { functionName: "onboarding-company-setup" });
      try {
        await saveCompanyViaClientFallback();
        markStepComplete(1);
        setCurrentStep(2);
        return;
      } catch (fallbackError) {
        if (isMissingEdgeFunctionError(edgeSave.error)) {
          throw new Error(
            `Onboarding edge save failed (${edgeMessage}). Fallback save also failed: ${getErrorMessage(fallbackError)}`,
          );
        }
        throw new Error(
          `Onboarding edge save failed (${edgeMessage}). Fallback save failed: ${getErrorMessage(fallbackError)}`,
        );
      }
    } catch (error) {
      toast({
        title: "Could not save company setup",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setSavingCompany(false);
    }
  };

  const goToNextStep = () => {
    if (currentStep === 4) return;
    markStepComplete(currentStep);
    setCurrentStep((prev) => (prev + 1) as StepId);
  };

  const goToPrevStep = () => {
    if (currentStep === 1) return;
    setCurrentStep((prev) => (prev - 1) as StepId);
  };

  const isStepCompleted = (step: StepId) => step <= maxCompletedStep;
  const isStepActive = (step: StepId) => step === currentStep;
  const remainingInvites = Math.max(0, STARTER_INVITE_LIMIT - teamInvites.length);

  const handleAddInvite = () => {
    if (!inviteEmail.trim()) return;

    if (teamInvites.length >= STARTER_INVITE_LIMIT) {
      toast({
        title: "Starter plan limit reached",
        description: `You can invite up to ${STARTER_INVITE_LIMIT} members on Starter.`,
        variant: "destructive",
      });
      return;
    }

    const normalizedEmail = inviteEmail.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address.",
        variant: "destructive",
      });
      return;
    }

    if (teamInvites.some((invite) => invite.email === normalizedEmail)) {
      toast({
        title: "Already added",
        description: "This team member is already in the invite list.",
        variant: "destructive",
      });
      return;
    }

    setTeamInvites((prev) => [...prev, { email: normalizedEmail, role: inviteRole }]);
    setInviteEmail("");
  };

  const removeInvite = (email: string) => {
    setTeamInvites((prev) => prev.filter((invite) => invite.email !== email));
  };

  const skipTeamInvites = () => {
    markStepComplete(2);
    setCurrentStep(3);
  };

  const sendInvitesAndContinue = async () => {
    const activeSession = await ensureActiveSession();
    if (!user || !activeSession) {
      toast({
        title: "Session expired",
        description: "Please sign in again to continue onboarding.",
        variant: "destructive",
      });
      navigate("/auth/login", { replace: true });
      return;
    }

    if (teamInvites.length === 0) {
      toast({
        title: "No invites added",
        description: "Add at least one invite or use Skip for now.",
        variant: "destructive",
      });
      return;
    }

    setSendingInvites(true);
    try {
      const workspace = await ensureUserWorkspace(user, { companyName: companyName.trim() || undefined });
      const resolvedTenantId = tenantId || workspace.tenantId;
      if (!resolvedTenantId) throw new Error("Could not resolve workspace tenant.");
      if (!tenantId) setTenantId(resolvedTenantId);

      const normalizedInvites = teamInvites.map((invite) => ({
        email: invite.email,
        role: invite.role.toLowerCase(),
      }));

      const trySaveInvitesViaClient = async () => {
        const rpcResult = await supabase.rpc("create_team_invitations", {
          p_invites: normalizedInvites,
        });

        if (!rpcResult.error) return;

        const nowIso = new Date().toISOString();
        const expiresIso = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        const tokenFor = () => (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID().replace(/-/g, "")
          : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

        const fullRows = normalizedInvites.map((invite) => ({
          tenant_id: resolvedTenantId,
          email: invite.email,
          role: invite.role,
          token: tokenFor(),
          status: "sent",
          invited_by: user.id,
          sent_at: nowIso,
          expires_at: expiresIso,
        }));

        const fullUpsert = await supabase
          .from("team_invitations")
          .upsert(fullRows, { onConflict: "tenant_id,email" })
          .select("id");

        if (!fullUpsert.error) return;
        if (!isMissingInvitationFieldError(fullUpsert.error)) throw fullUpsert.error;

        const minimalRows = normalizedInvites.map((invite) => ({
          tenant_id: resolvedTenantId,
          email: invite.email,
          role: invite.role,
          token: tokenFor(),
          status: "pending",
        }));

        const minimalUpsert = await supabase
          .from("team_invitations")
          .upsert(minimalRows, { onConflict: "tenant_id,email" })
          .select("id");

        if (minimalUpsert.error) throw minimalUpsert.error;
      };

      const edgeResult = await invokeEdge("send-team-invites", {
        body: { invites: normalizedInvites },
      });

      if (edgeResult.error) {
        const edgeMessage = await formatEdgeFunctionError(edgeResult.error, { functionName: "send-team-invites" });
        if (isMissingEdgeFunctionError(edgeResult.error)) {
          try {
            await trySaveInvitesViaClient();
          } catch (fallbackError) {
            throw new Error(
              `Invite backend function is not available (${edgeMessage}). Fallback save also failed: ${getErrorMessage(fallbackError)}`,
            );
          }
        } else {
          throw new Error(`Could not send invitation emails (${edgeMessage})`);
        }
      }

      toast({
        title: "Invitations sent!",
      });

      markStepComplete(2);
      setCurrentStep(3);
    } catch (error) {
      toast({
        title: "Could not send invites",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSendingInvites(false);
    }
  };

  const toggleSecret = (field: string) => {
    setShowSecrets((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const handleServiceAccountFile = async (file: File | null) => {
    if (!file) return;
    if (!file.name.endsWith(".json")) {
      toast({
        title: "Unsupported file",
        description: "Please upload a JSON credentials file.",
        variant: "destructive",
      });
      return;
    }

    try {
      const content = await file.text();
      setSheetsForm((prev) => ({ ...prev, serviceAccountFileName: file.name, serviceAccountJson: content }));
    } catch {
      toast({
        title: "Could not read JSON file",
        description: "Please try uploading the file again.",
        variant: "destructive",
      });
    }
  };

  const isValidUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  };

  const validateConnectionConfig = (): ConnectionValidation => {
    if (!selectedConnectionType) {
      return { error: "Please select a connection type first." };
    }

    if (selectedConnectionType === "rest_openapi") {
      if (!restForm.name.trim() || !restForm.baseUrl.trim() || !restForm.apiKey.trim()) {
        return { error: "REST API requires Name, Base URL, and API Key." };
      }
      if (!isValidUrl(restForm.baseUrl.trim())) return { error: "Base URL must be a valid http/https URL." };
      if (restForm.specUrl.trim() && !isValidUrl(restForm.specUrl.trim())) {
        return { error: "Swagger/OpenAPI URL is invalid." };
      }
      const baseUrl = restForm.baseUrl.trim();
      const openApiUrl = restForm.specUrl.trim();
      return {
        name: restForm.name.trim(),
        baseUrl,
        authType: "api_key",
        config: {
          base_url: baseUrl,
          auth_type: "api_key",
          api_key: restForm.apiKey.trim(),
          openapi_url: openApiUrl || null,
          sync_frequency: "hourly",
        },
        testPayload: {
          base_url: baseUrl,
          baseUrl,
          openapi_url: openApiUrl || null,
          api_key: restForm.apiKey.trim(),
          apiKey: restForm.apiKey.trim(),
          url: openApiUrl || baseUrl,
        },
      };
    }

    if (selectedConnectionType === "custom_rest") {
      if (!customRestForm.name.trim() || !customRestForm.baseUrl.trim() || !customRestForm.apiKey.trim()) {
        return { error: "Custom REST requires Name, Base URL, and API Key." };
      }
      if (!isValidUrl(customRestForm.baseUrl.trim())) return { error: "Base URL must be a valid http/https URL." };
      const baseUrl = customRestForm.baseUrl.trim();
      return {
        name: customRestForm.name.trim(),
        baseUrl,
        authType: "api_key",
        config: {
          base_url: baseUrl,
          auth_type: "api_key",
          api_key: customRestForm.apiKey.trim(),
          sync_frequency: "hourly",
        },
        testPayload: {
          base_url: baseUrl,
          baseUrl,
          api_key: customRestForm.apiKey.trim(),
          apiKey: customRestForm.apiKey.trim(),
          url: baseUrl,
        },
      };
    }

    if (selectedConnectionType === "postgresql" || selectedConnectionType === "mysql") {
      if (
        !sqlForm.name.trim() ||
        !sqlForm.host.trim() ||
        !sqlForm.port.trim() ||
        !sqlForm.database.trim() ||
        !sqlForm.username.trim() ||
        !sqlForm.password.trim()
      ) {
        return { error: "Database connection requires all fields." };
      }
      const portNumber = Number(sqlForm.port);
      if (!Number.isInteger(portNumber) || portNumber <= 0) {
        return { error: "Port must be a valid positive number." };
      }

      const baseUrl = `${sqlForm.host.trim()}:${sqlForm.port.trim()}/${sqlForm.database.trim()}`;
      const port = Number(sqlForm.port);
      return {
        name: sqlForm.name.trim(),
        baseUrl,
        authType: "none",
        config: {
          host: sqlForm.host.trim(),
          port,
          database: sqlForm.database.trim(),
          username: sqlForm.username.trim(),
          password: sqlForm.password,
          ssl_mode: sqlForm.ssl ? "require" : "disable",
          sync_frequency: "hourly",
        },
        testPayload: {
          host: sqlForm.host.trim(),
          port,
          database: sqlForm.database.trim(),
          username: sqlForm.username.trim(),
          password: sqlForm.password,
          base_url: baseUrl,
          baseUrl,
        },
      };
    }

    if (selectedConnectionType === "mongodb") {
      if (!mongoForm.name.trim() || !mongoForm.connectionString.trim()) {
        return { error: "MongoDB requires Name and Connection String." };
      }
      const conn = mongoForm.connectionString.trim();
      if (!conn.startsWith("mongodb://") && !conn.startsWith("mongodb+srv://")) {
        return { error: "Connection string must start with mongodb:// or mongodb+srv://." };
      }
      return {
        name: mongoForm.name.trim(),
        baseUrl: conn,
        authType: "none",
        config: {
          connection_string: conn,
          sync_frequency: "hourly",
        },
        testPayload: {
          connection_string: conn,
          connectionString: conn,
          url: conn,
        },
      };
    }

    if (selectedConnectionType === "google_sheets") {
      if (!sheetsForm.name.trim() || !sheetsForm.sheetUrl.trim() || !sheetsForm.serviceAccountFileName.trim()) {
        return { error: "Google Sheets requires Name, Sheet URL, and Service Account JSON." };
      }
      if (!isValidUrl(sheetsForm.sheetUrl.trim())) return { error: "Sheet URL is invalid." };
      let parsedServiceAccount: unknown = sheetsForm.serviceAccountJson.trim();
      try {
        parsedServiceAccount = JSON.parse(sheetsForm.serviceAccountJson);
      } catch {
        return { error: "Service Account JSON file is invalid." };
      }

      const baseUrl = sheetsForm.sheetUrl.trim();
      return {
        name: sheetsForm.name.trim(),
        baseUrl,
        authType: "none",
        config: {
          sheet_url: baseUrl,
          service_account_json: parsedServiceAccount,
          sync_frequency: "hourly",
        },
        testPayload: {
          sheet_url: baseUrl,
          sheetUrl: baseUrl,
          url: baseUrl,
        },
      };
    }

    if (selectedConnectionType === "notion") {
      if (!notionForm.name.trim() || !notionForm.integrationToken.trim() || !notionForm.databaseId.trim()) {
        return { error: "Notion requires Name, Integration Token, and Database ID." };
      }
      const databaseId = notionForm.databaseId.trim();
      return {
        name: notionForm.name.trim(),
        baseUrl: `notion://database/${databaseId}`,
        authType: "none",
        config: {
          integration_token: notionForm.integrationToken.trim(),
          database_id: databaseId,
          sync_frequency: "hourly",
        },
        testPayload: {
          integration_token: notionForm.integrationToken.trim(),
          integrationToken: notionForm.integrationToken.trim(),
          database_id: databaseId,
        },
      };
    }

    return { error: "Unsupported connection type." };
  };

  const startAnalysisAnimation = () => {
    setAnalysisVisible(true);
  };

  const startSchemaDiscovery = async (connectionId: string, triggerReason: string) => {
    const dispatchResponse = await invokeEdge("connector-sync-dispatch", {
      body: {
        connectionId,
        jobType: "schema_discovery",
        triggerReason,
        priority: 75,
        idempotencyKey: `${connectionId}:${triggerReason}:${Date.now()}`,
      },
    });

    if (!dispatchResponse.error && dispatchResponse.data?.jobId) {
      return {
        mode: "queued" as const,
        jobId: String(dispatchResponse.data.jobId),
        warning:
          typeof dispatchResponse.data.warning === "string"
            ? dispatchResponse.data.warning
            : null,
      };
    }

    const dispatchErrorMessage = dispatchResponse.error
      ? sanitizeConnectionErrorMessage(
          await formatEdgeFunctionError(dispatchResponse.error, {
            functionName: "connector-sync-dispatch",
          }),
        )
      : null;

    const fallback = await invokeEdge("run-schema-discovery", {
      body: { connectionId },
    });
    if (fallback.error) {
      const fallbackMessage = sanitizeConnectionErrorMessage(
        await formatEdgeFunctionError(fallback.error, {
          functionName: "run-schema-discovery",
        }),
      );
      throw new Error(dispatchErrorMessage ? `${dispatchErrorMessage} ${fallbackMessage}` : fallbackMessage);
    }
    if (fallback.data?.jobId) {
      return {
        mode: "queued" as const,
        jobId: String(fallback.data.jobId),
        warning:
          typeof fallback.data.warning === "string"
            ? fallback.data.warning
            : null,
      };
    }
    if (dispatchErrorMessage) throw new Error(dispatchErrorMessage);
    throw new Error("Schema discovery did not return a job id.");
  };

  const handleTestConnection = async () => {
    const activeSession = await ensureActiveSession();
    if (!user || !activeSession) {
      toast({
        title: "Session expired",
        description: "Please sign in again to continue onboarding.",
        variant: "destructive",
      });
      navigate("/auth/login", { replace: true });
      return;
    }

    setTestingConnection(true);
    setTestOutcome({ status: "idle", message: "" });

    const validation = validateConnectionConfig();
    if ("error" in validation) {
      setTestingConnection(false);
      setTestOutcome({ status: "error", message: validation.error });
      return;
    }

    try {
      const invokePayload = {
        connectionType: selectedConnectionType,
        payload: validation.testPayload,
      };

      const { data: testData, error: testError } = await invokeEdge("test-data-connection", {
        body: invokePayload,
      });

      if (testError) {
        const parsedMessage = await formatEdgeFunctionError(testError, { functionName: "test-data-connection" });
        throw new Error(sanitizeConnectionErrorMessage(parsedMessage));
      }

      if (!testData?.success) {
        const rawMessage = typeof testData?.message === "string" ? testData.message : "Connection failed.";
        const messageWithDetails = `${rawMessage}${detailsToMessageSuffix(testData?.details)}`.trim();
        throw new Error(sanitizeConnectionErrorMessage(messageWithDetails));
      }
      setTestOutcome({ status: "success", message: "Connection successful ✓" });
    } catch (error) {
      let baseMessage = error instanceof Error ? error.message : "Connection failed.";
      if (baseMessage.toLowerCase().includes("non-2xx")) {
        baseMessage = await formatEdgeFunctionError(error, { functionName: "test-data-connection" });
      }
      const safeMessage = sanitizeConnectionErrorMessage(baseMessage);
      setTestOutcome({
        status: "error",
        message: safeMessage,
      });
      if (isSessionExpiredMessage(safeMessage)) {
        const latestSession = await ensureActiveSession();
        if (!latestSession) {
          toast({
            title: "Session expired",
            description: "Please sign in again to continue onboarding.",
            variant: "destructive",
          });
          navigate("/auth/login", { replace: true });
        }
      }
    } finally {
      setTestingConnection(false);
    }
  };

  const continueFromDataStep = async () => {
    if (connectionAdded) {
      markStepComplete(3);
      setCurrentStep(4);
      return;
    }

    if (testOutcome.status !== "success") {
      setTestOutcome({
        status: "error",
        message: "Run Test Connection successfully before continuing.",
      });
      return;
    }

    const activeSession = await ensureActiveSession();
    if (!user || !activeSession) {
      toast({
        title: "Session expired",
        description: "Please sign in again to continue onboarding.",
        variant: "destructive",
      });
      navigate("/auth/login", { replace: true });
      return;
    }

    const validation = validateConnectionConfig();
    if ("error" in validation) {
      setTestOutcome({ status: "error", message: validation.error });
      return;
    }

    setSavingDataConnection(true);
    try {
      const workspace =
        tenantId !== null
          ? { tenantId, role: "owner" }
          : await ensureUserWorkspace(user, { companyName: companyName.trim() || undefined });

      if (!tenantId) setTenantId(workspace.tenantId);

      let connectionId = savedConnectionId;
      if (!connectionId) {
        const existingWithArchiveFilter = await supabase
          .from("api_connections")
          .select("id")
          .eq("tenant_id", workspace.tenantId)
          .eq("type", selectedConnectionType as string)
          .eq("name", validation.name)
          .eq("is_archived", false)
          .order("updated_at", { ascending: false })
          .limit(1);

        let existingConnection = existingWithArchiveFilter.data?.[0] ?? null;
        if (existingWithArchiveFilter.error) {
          const fallbackLookup = await supabase
            .from("api_connections")
            .select("id")
            .eq("tenant_id", workspace.tenantId)
            .eq("type", selectedConnectionType as string)
            .eq("name", validation.name)
            .order("updated_at", { ascending: false })
            .limit(1);
          if (fallbackLookup.error) throw fallbackLookup.error;
          existingConnection = fallbackLookup.data?.[0] ?? null;
        }

        if (existingConnection?.id) {
          connectionId = existingConnection.id;
          setSavedConnectionId(existingConnection.id);
        }
      }

      if (connectionId) {
        const { error } = await supabase
          .from("api_connections")
          .update({
            name: validation.name,
            type: selectedConnectionType as string,
            base_url: validation.baseUrl,
            auth_type: validation.authType,
            connection_config: validation.config,
            status: "pending",
            schema_detected: false,
            last_error: null,
          })
          .eq("id", connectionId)
          .eq("tenant_id", workspace.tenantId);

        if (error) throw error;
        await startSchemaDiscovery(connectionId, "onboarding_step_3_existing_connection");
      } else {
        const { data: created, error: createError } = await invokeEdge("create-data-connection", {
          body: {
            name: validation.name,
            type: selectedConnectionType,
            baseUrl: validation.baseUrl,
            authType: validation.authType,
            config: {
              ...validation.config,
              onboarding: true,
              source: "onboarding_step_3",
            },
            seedSchema: false,
            autoSync: true,
          },
        });

        if (createError) {
          const parsedCreateError = await formatEdgeFunctionError(createError, {
            functionName: "create-data-connection",
          });
          throw new Error(sanitizeConnectionErrorMessage(parsedCreateError));
        }
        if (!created?.connectionId) {
          throw new Error("Connection created without a valid id.");
        }
        if (created?.queueFailed) {
          throw new Error(
            typeof created.warning === "string" && created.warning.trim().length > 0
              ? created.warning
              : "Connection was created, but schema discovery could not be queued.",
          );
        }
        if (typeof created?.warning === "string" && created.warning.trim().length > 0) {
          toast({
            title: "Connection saved with warnings",
            description: sanitizeConnectionErrorMessage(created.warning),
          });
        }

        connectionId = created.connectionId as string;
        setSavedConnectionId(connectionId);
      }

      setConnectionAdded(true);
      startAnalysisAnimation();
      setAnalysisMessage("Schema discovery has been queued in background. You can track real progress in Connections > View Schema.");

      markStepComplete(3);
      setCurrentStep(4);
    } catch (error) {
      let baseMessage = error instanceof Error ? error.message : "Could not save connection.";
      if (baseMessage.toLowerCase().includes("non-2xx")) {
        baseMessage = await formatEdgeFunctionError(error, { functionName: "create-data-connection" });
      }
      const safeMessage = sanitizeConnectionErrorMessage(baseMessage);

      if (isConnectionLimitReachedMessage(safeMessage) && user) {
        try {
          const workspace =
            tenantId !== null
              ? { tenantId, role: "owner" }
              : await ensureUserWorkspace(user, { companyName: companyName.trim() || undefined });

          const primaryLookup = await supabase
            .from("api_connections")
            .select("id,name")
            .eq("tenant_id", workspace.tenantId)
            .eq("is_archived", false)
            .order("updated_at", { ascending: false })
            .limit(1);

          let existingConnection = primaryLookup.data?.[0] ?? null;
          if (primaryLookup.error) {
            const fallbackLookup = await supabase
              .from("api_connections")
              .select("id,name")
              .eq("tenant_id", workspace.tenantId)
              .order("updated_at", { ascending: false })
              .limit(1);
            if (!fallbackLookup.error) {
              existingConnection = fallbackLookup.data?.[0] ?? null;
            }
          }

          if (existingConnection?.id) {
            setSavedConnectionId(String(existingConnection.id));
            setConnectionAdded(true);
            startAnalysisAnimation();
            setAnalysisMessage(
              `Using existing connection "${existingConnection.name}". Schema discovery can be tracked from Connections > View Schema.`,
            );
            toast({
              title: "Using existing connection",
              description:
                "Your current plan limit is reached, so onboarding will continue with your existing source.",
            });
            markStepComplete(3);
            setCurrentStep(4);
            return;
          }
        } catch {
          // Fall through to standard error handling below.
        }
      }

      setTestOutcome({
        status: "error",
        message: safeMessage,
      });
      if (isSessionExpiredMessage(safeMessage)) {
        const latestSession = await ensureActiveSession();
        if (!latestSession) {
          toast({
            title: "Session expired",
            description: "Please sign in again to continue onboarding.",
            variant: "destructive",
          });
          navigate("/auth/login", { replace: true });
        }
      }
    } finally {
      setSavingDataConnection(false);
    }
  };

  const initialsFromLabel = (label: string) => {
    const parts = label.split(" ").filter(Boolean);
    if (parts.length === 0) return "U";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  };

  const triggerConfettiBurst = async () => {
    try {
      const moduleName = "canvas-confetti";
      const confettiModule = await import(/* @vite-ignore */ moduleName);
      const fire = (confettiModule.default ?? confettiModule) as (opts?: Record<string, unknown>) => void;
      fire({
        particleCount: 120,
        spread: 75,
        origin: { y: 0.6 },
      });
      fire({
        particleCount: 80,
        spread: 100,
        origin: { x: 0.2, y: 0.6 },
      });
      fire({
        particleCount: 80,
        spread: 100,
        origin: { x: 0.8, y: 0.6 },
      });
    } catch {
      setShowConfettiFallback(true);
      window.setTimeout(() => setShowConfettiFallback(false), 1800);
    }
  };

  const loadLaunchSummary = useCallback(async () => {
    if (!user) return;
    setLoadingLaunchSummary(true);

    try {
      const workspace =
        tenantId !== null
          ? { tenantId, role: "owner" }
          : await ensureUserWorkspace(user, { companyName: companyName.trim() || undefined });
      if (!tenantId) setTenantId(workspace.tenantId);

      const [
        { data: sourcesData, error: sourcesError },
        { data: profilesData, error: profilesError },
        { data: invitesData },
        { data: agentsData, error: agentsError },
        { data: syncRunsData, error: syncRunsError },
        { data: embeddingJobsData, error: embeddingJobsError },
      ] = await Promise.all([
        supabase
          .from("api_connections")
          .select("id, name")
          .eq("tenant_id", workspace.tenantId)
          .order("created_at", { ascending: true }),
        supabase
          .from("profiles")
          .select("id, full_name, avatar_url")
          .eq("tenant_id", workspace.tenantId),
        supabase
          .from("team_invitations")
          .select("id, email")
          .eq("tenant_id", workspace.tenantId)
          .eq("status", "pending"),
        supabase
          .from("ai_agents")
          .select("id, name, status")
          .eq("tenant_id", workspace.tenantId)
          .order("created_at", { ascending: true }),
        supabase
          .from("connection_sync_runs")
          .select("status, started_at, finished_at")
          .eq("tenant_id", workspace.tenantId)
          .order("started_at", { ascending: false })
          .limit(20),
        supabase
          .from("embedding_jobs")
          .select("status, created_at, started_at, finished_at")
          .eq("tenant_id", workspace.tenantId)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

      if (sourcesError) throw sourcesError;
      if (profilesError) throw profilesError;
      if (agentsError) throw agentsError;
      if (syncRunsError) throw syncRunsError;
      if (embeddingJobsError) throw embeddingJobsError;

      setConnectedSources((sourcesData ?? []) as SummaryConnection[]);

      const profileMembers: SummaryMember[] = (profilesData ?? []).map((profile: { id: string; full_name: string | null; avatar_url: string | null }) => ({
        id: profile.id,
        label: profile.full_name || "Team member",
        avatarUrl: profile.avatar_url,
      }));

      const invitedMembers: SummaryMember[] = (invitesData ?? []).map((invite) => ({
        id: invite.id,
        label: invite.email,
        avatarUrl: null,
      }));

      const deduped = [...profileMembers, ...invitedMembers].filter(
        (member, index, arr) =>
          arr.findIndex((candidate) => candidate.label.toLowerCase() === member.label.toLowerCase()) === index,
      );

      setTeamMembers(deduped);
      setWorkspaceAgents((agentsData ?? []) as SummaryAgent[]);

      const sourceRows = (sourcesData ?? []) as SummaryConnection[];
      const syncRows = (syncRunsData ?? []) as Array<{ status: string }>;
      const embeddingRows = (embeddingJobsData ?? []) as Array<{ status: string }>;

      const hasSyncRunning = syncRows.some((row) => ["pending", "running"].includes(String(row.status).toLowerCase()));
      const hasSyncSuccess = syncRows.some((row) => String(row.status).toLowerCase() === "success");

      const hasEmbeddingRunning = embeddingRows.some((row) =>
        ["pending", "scheduled", "running"].includes(String(row.status).toLowerCase()),
      );
      const hasEmbeddingSuccess = embeddingRows.some((row) => String(row.status).toLowerCase() === "success");

      if (
        sourceRows.length > 0 &&
        (hasSyncSuccess || !hasSyncRunning) &&
        (agentsData?.length ?? 0) === 0 &&
        !launchAutoRegenerateRef.current
      ) {
        launchAutoRegenerateRef.current = true;
        void (async () => {
          const regenerate = await invokeEdge("agent-regenerate", {
            body: {
              force: false,
              reason: "onboarding_launch_auto",
            },
          });
          if (regenerate.error) {
            // Allow a retry on next polling cycle if the background call failed.
            launchAutoRegenerateRef.current = false;
          }
        })();
      }

      if (!hasSyncRunning && !hasSyncSuccess && sourceRows.length > 0 && !launchSyncKickoffRef.current) {
        launchSyncKickoffRef.current = true;
        void startSchemaDiscovery(sourceRows[0].id, "onboarding_launch").catch(() => {
          // Non-blocking kickoff; status lines still render based on persisted runs/jobs.
        });
      }

      setLaunchPipelineStatus({
        schema: hasSyncRunning
          ? "Schema detection is running in background."
          : hasSyncSuccess
            ? "Schema detection completed. Incremental sync will keep it fresh."
            : sourceRows.length > 0
              ? "Schema detection is queued and will start shortly."
              : "No sources connected yet for schema detection.",
        rag: hasEmbeddingRunning
          ? "RAG indexing is in progress."
          : hasEmbeddingSuccess
            ? "RAG indexing completed. New syncs will refresh embeddings."
            : "RAG indexing will begin after schema discovery extracts entities.",
        email: hasEmbeddingSuccess
          ? "RAG is ready. You can query your data now."
          : "You’ll get an email when RAG is ready.",
      });
    } catch (error) {
      toast({
        title: "Could not load launch summary",
        description: error instanceof Error ? error.message : "Please refresh and try again.",
        variant: "destructive",
      });
    } finally {
      setLoadingLaunchSummary(false);
    }
  }, [companyName, tenantId, toast, user]);

  useEffect(() => {
    if (currentStep !== 4) {
      confettiFiredRef.current = false;
      if (launchSummaryPollingRef.current !== null) {
        window.clearInterval(launchSummaryPollingRef.current);
        launchSummaryPollingRef.current = null;
      }
      return;
    }

    void loadLaunchSummary();
    if (launchSummaryPollingRef.current === null) {
      launchSummaryPollingRef.current = window.setInterval(() => {
        void loadLaunchSummary();
      }, 10_000);
    }
    if (!confettiFiredRef.current) {
      confettiFiredRef.current = true;
      void triggerConfettiBurst();
    }
    return () => {
      if (launchSummaryPollingRef.current !== null) {
        window.clearInterval(launchSummaryPollingRef.current);
        launchSummaryPollingRef.current = null;
      }
    };
  }, [currentStep, loadLaunchSummary]);

  const toggleRaciSuggestion = (id: string, enabled: boolean) => {
    setRaciSuggestions((prev) => prev.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)));
  };

  const activateTenantAndLaunch = async (destination: "dashboard" | "raci") => {
    if (!user) return;
    setLaunchingDestination(destination);

    try {
      const raciPayload = raciSuggestions.map((rule) => ({
        enabled: rule.enabled,
        resource: rule.resource,
        action: rule.action,
        responsible_role: rule.responsibleRole,
        accountable_role: rule.accountableRole,
      }));

      const launchViaClientFallback = async (edgeMessage: string) => {
        const workspace = await ensureUserWorkspace(user, { companyName: companyName.trim() || undefined });
        const resolvedTenantId = tenantId || workspace.tenantId;
        if (!tenantId) setTenantId(resolvedTenantId);

        const nowIso = new Date().toISOString();
        const tenantUpdate = await supabase
          .from("tenants")
          .update({
            status: "active",
            onboarding_step: 4,
            onboarding_completed_at: nowIso,
            activated_at: nowIso,
          })
          .eq("id", resolvedTenantId);
        if (tenantUpdate.error) throw tenantUpdate.error;

        const rules = raciPayload.flatMap((rule) => {
          if (!rule.enabled || !rule.resource || !rule.action) return [] as Array<Record<string, string>>;
          const rows: Array<Record<string, string>> = [];
          if (rule.responsible_role) {
            rows.push({
              tenant_id: resolvedTenantId,
              resource: rule.resource,
              action: rule.action,
              role_name: rule.responsible_role,
              raci_type: "R",
            });
          }
          if (rule.accountable_role) {
            rows.push({
              tenant_id: resolvedTenantId,
              resource: rule.resource,
              action: rule.action,
              role_name: rule.accountable_role,
              raci_type: "A",
            });
          }
          return rows;
        });

        if (rules.length > 0) {
          const upsertRules = await supabase
            .from("raci_matrix")
            .upsert(rules, { onConflict: "tenant_id,resource,action,role_name,raci_type" });
          if (upsertRules.error) {
            const insertRules = await supabase.from("raci_matrix").insert(rules);
            if (insertRules.error) throw insertRules.error;
          }
        }

        const regenerate = await supabase.rpc("regenerate_agents_for_tenant", {
          p_tenant_id: resolvedTenantId,
          p_force: false,
        });
        if (regenerate.error) {
          const message = String(regenerate.error.message ?? "").toLowerCase();
          const ambiguousTenantError =
            (regenerate.error.code === "42702" && message.includes("tenant_id")) ||
            (message.includes("tenant_id") && message.includes("ambiguous"));
          if (!ambiguousTenantError) throw regenerate.error;
        }

        await supabase.from("audit_logs").insert({
          tenant_id: resolvedTenantId,
          user_id: user.id,
          action: "workspace.launch",
          resource: "tenant",
          status: "success",
          details: {
            fallback: true,
            edge_error: edgeMessage,
          },
        });
      };

      const edgeLaunch = await invokeEdge("launch-workspace", {
        body: {
          raciRules: raciPayload,
        },
      });
      if (edgeLaunch.error) {
        const parsedEdgeError = await formatEdgeFunctionError(edgeLaunch.error, { functionName: "launch-workspace" });
        try {
          await launchViaClientFallback(parsedEdgeError);
        } catch (fallbackError) {
          const workspace = await ensureUserWorkspace(user, { companyName: companyName.trim() || undefined });
          const statusCheck = await supabase
            .from("tenants")
            .select("status")
            .eq("id", workspace.tenantId)
            .maybeSingle();
          const tenantStatus = String(statusCheck.data?.status ?? "").toLowerCase();
          if (tenantStatus !== "active") {
            throw new Error(
              fallbackError instanceof Error
                ? fallbackError.message
                : "Workspace launch fallback failed.",
            );
          }
          toast({
            title: "Workspace launched with warnings",
            description:
              fallbackError instanceof Error
                ? fallbackError.message
                : "Activation completed, but some post-launch steps need retry.",
          });
          navigate(destination === "dashboard" ? "/dashboard" : "/dashboard/raci");
          return;
        }
        toast({
          title: "Workspace launched",
          description: "Activation completed through safe fallback.",
        });
        navigate(destination === "dashboard" ? "/dashboard" : "/dashboard/raci");
        return;
      }

      toast({
        title: "Workspace launched",
        description: "Your tenant is now active.",
      });

      navigate(destination === "dashboard" ? "/dashboard" : "/dashboard/raci");
    } catch (error) {
      let baseMessage = error instanceof Error ? error.message : "Please try again.";
      if (baseMessage.toLowerCase().includes("non-2xx")) {
        baseMessage = await formatEdgeFunctionError(error, { functionName: "launch-workspace" });
      }
      toast({
        title: "Could not launch workspace",
        description: baseMessage,
        variant: "destructive",
      });
    } finally {
      setLaunchingDestination(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-7">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          {STEP_CONFIG.map((step, index) => {
            const completed = isStepCompleted(step.id);
            const active = isStepActive(step.id);

            return (
              <div key={step.id} className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  onClick={() => {
                    if (step.id <= maxCompletedStep + 1) setCurrentStep(step.id);
                  }}
                  className="group inline-flex min-w-0 items-center gap-3 text-left"
                >
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors",
                      completed && "border-violet-600 bg-violet-600 text-white",
                      active && !completed && "border-violet-600 bg-violet-100 text-violet-700",
                      !active && !completed && "border-slate-300 bg-slate-50 text-slate-500",
                    )}
                  >
                    {completed ? <Check className="h-4 w-4" /> : step.id}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "truncate text-sm font-semibold",
                        active || completed ? "text-slate-900" : "text-slate-500",
                      )}
                    >
                      Step {step.id}: {step.label}
                    </p>
                  </div>
                </button>

                {index < STEP_CONFIG.length - 1 && (
                  <div
                    className={cn(
                      "mx-3 hidden h-0.5 flex-1 rounded md:block",
                      step.id < currentStep || completed ? "bg-violet-500" : "bg-slate-200",
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        {loadingProfile ? (
          <div className="flex min-h-[320px] items-center justify-center">
            <div className="h-8 w-8 animate-pulse rounded-lg bg-gradient-to-br from-violet-700 to-purple-600" />
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
            >
              {currentStep === 1 && (
                <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
                  <div className="space-y-5">
                    <div>
                      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Tell us about your company</h1>
                      <p className="mt-1 text-sm text-slate-600">
                        This helps us personalize governance defaults and onboarding recommendations.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Company Logo</Label>
                      <div
                        onDragEnter={(event) => {
                          event.preventDefault();
                          setDraggingLogo(true);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setDraggingLogo(true);
                        }}
                        onDragLeave={(event) => {
                          event.preventDefault();
                          setDraggingLogo(false);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          setDraggingLogo(false);
                          const file = event.dataTransfer.files?.[0] ?? null;
                          handleLogoFile(file);
                        }}
                        className={cn(
                          "flex h-28 w-28 cursor-pointer items-center justify-center rounded-full border-2 border-dashed transition-colors",
                          draggingLogo ? "border-violet-500 bg-violet-50" : "border-slate-300 bg-slate-50",
                        )}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {companyLogoPreview ? (
                          <img
                            src={companyLogoPreview}
                            alt="Company logo preview"
                            loading="lazy"
                            decoding="async"
                            className="h-24 w-24 rounded-full object-cover"
                          />
                        ) : (
                          <CloudUpload className="h-6 w-6 text-slate-500" />
                        )}
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => handleLogoFile(event.target.files?.[0] ?? null)}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="companyName">Company Name</Label>
                      <Input
                        id="companyName"
                        value={companyName}
                        onChange={(event) => setCompanyName(event.target.value)}
                        placeholder="Acme Inc."
                      />
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Industry</Label>
                        <Select value={industry} onValueChange={setIndustry}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select industry" />
                          </SelectTrigger>
                          <SelectContent>
                            {INDUSTRIES.map((item) => (
                              <SelectItem key={item} value={item}>
                                {item}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Default Region</Label>
                        <Select value={defaultRegion} onValueChange={setDefaultRegion}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select region" />
                          </SelectTrigger>
                          <SelectContent>
                            {REGIONS.map((region) => (
                              <SelectItem key={region} value={region}>
                                {region}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-slate-500">Affects data residency and storage locality.</p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Company Size</Label>
                      <div className="flex flex-wrap gap-2">
                        {SIZE_OPTIONS.map((size) => (
                          <button
                            key={size}
                            type="button"
                            onClick={() => setCompanySize(size)}
                            className={cn(
                              "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                              companySize === size
                                ? "border-violet-600 bg-violet-600 text-white"
                                : "border-slate-300 bg-white text-slate-700 hover:border-violet-300",
                            )}
                          >
                            {size}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Primary Use Case</Label>
                      <Select value={primaryUseCase} onValueChange={setPrimaryUseCase}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select use case" />
                        </SelectTrigger>
                        <SelectContent>
                          {USE_CASES.map((useCase) => (
                            <SelectItem key={useCase} value={useCase}>
                              {useCase}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="pt-2">
                      <Button
                        onClick={handleCompanyContinue}
                        className="bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
                        disabled={savingCompany}
                      >
                        {savingCompany ? "Saving..." : "Continue"}
                        {!savingCompany && <ArrowRight className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="hidden rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-indigo-50 p-6 lg:block">
                    <div className="flex h-full flex-col items-center justify-center text-center">
                      <span className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg">
                        <Building2 className="h-8 w-8" />
                      </span>
                      <h3 className="text-lg font-semibold text-slate-900">Workspace Profile</h3>
                      <p className="mt-2 text-sm text-slate-600">
                        Your company setup configures governance defaults, regional compliance, and onboarding suggestions.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {currentStep === 2 && (
                <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
                  <div className="space-y-6">
                    <div>
                      <h2 className="text-2xl font-bold tracking-tight text-slate-900">Bring your team onboard</h2>
                      <p className="mt-1 text-sm text-slate-600">
                        Invite teammates to collaborate with role-based access controls.
                      </p>
                    </div>

                    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                      <div className="flex items-start gap-2">
                        <Info className="mt-0.5 h-4 w-4 shrink-0" />
                        <p>Invitees will receive an email with a link to join your workspace.</p>
                      </div>
                    </div>

                    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label className="text-sm font-semibold text-slate-900">Team invitations</Label>
                        <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                          {remainingInvites} remaining
                        </span>
                      </div>

                      <div className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
                        <Input
                          value={inviteEmail}
                          onChange={(event) => setInviteEmail(event.target.value)}
                          placeholder="name@company.com"
                          type="email"
                        />
                        <Select
                          value={inviteRole}
                          onValueChange={(value) => setInviteRole(value as (typeof TEAM_ROLES)[number])}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TEAM_ROLES.map((role) => (
                              <SelectItem key={role} value={role}>
                                {role}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleAddInvite}
                          disabled={!inviteEmail.trim() || remainingInvites <= 0}
                        >
                          <Plus className="h-4 w-4" />
                          Add
                        </Button>
                      </div>

                      {teamInvites.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {teamInvites.map((invite) => (
                            <span
                              key={invite.email}
                              className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700"
                            >
                              <span className="font-medium">{invite.email}</span>
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] uppercase tracking-wide">
                                {invite.role}
                              </span>
                              <button
                                type="button"
                                onClick={() => removeInvite(invite.email)}
                                className="text-slate-500 hover:text-slate-700"
                                aria-label={`Remove ${invite.email}`}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                      <Button
                        onClick={sendInvitesAndContinue}
                        className="bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
                        disabled={sendingInvites}
                      >
                        {sendingInvites ? "Sending..." : "Send Invites & Continue"}
                        {!sendingInvites && <ArrowRight className="h-4 w-4" />}
                      </Button>
                      <button
                        type="button"
                        onClick={skipTeamInvites}
                        className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-700"
                      >
                        Skip for now
                      </button>
                    </div>
                  </div>

                  <div className="hidden rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-indigo-50 p-6 lg:block">
                    <div className="flex h-full flex-col items-center justify-center text-center">
                      <span className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg">
                        <UserPlus2 className="h-8 w-8" />
                      </span>
                      <h3 className="text-lg font-semibold text-slate-900">Team Access</h3>
                      <p className="mt-2 text-sm text-slate-600">
                        Keep permissions tight from day one with scoped roles for each teammate.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {currentStep === 3 && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-slate-900">Connect your first data source</h2>
                    <p className="mt-1 text-sm text-slate-600">
                      Choose a connector type and validate access before we begin schema analysis.
                    </p>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    {CONNECTION_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSelectedConnectionType(option.value)}
                        className={cn(
                          "rounded-xl border p-4 text-left transition-all",
                          selectedConnectionType === option.value
                            ? "border-violet-500 bg-violet-50 shadow-sm"
                            : "border-slate-200 bg-white hover:border-violet-300",
                        )}
                      >
                        <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                          <option.icon className="h-5 w-5" />
                        </div>
                        <h3 className="font-semibold text-slate-900">{option.title}</h3>
                        <p className="text-sm text-slate-600">{option.subtitle}</p>
                      </button>
                    ))}
                  </div>

                  {selectedConnectionType && (
                    <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                      {selectedConnectionType === "rest_openapi" && (
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label="Name">
                            <Input
                              value={restForm.name}
                              onChange={(event) => setRestForm((prev) => ({ ...prev, name: event.target.value }))}
                              placeholder="ERP Core API"
                            />
                          </Field>
                          <Field label="Base URL">
                            <Input
                              value={restForm.baseUrl}
                              onChange={(event) => setRestForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                              placeholder="https://api.example.com"
                            />
                          </Field>
                          <Field label="API Key">
                            <SecretInput
                              value={restForm.apiKey}
                              onChange={(value) => setRestForm((prev) => ({ ...prev, apiKey: value }))}
                              placeholder="Paste API key"
                              visible={showSecrets.restApiKey}
                              onToggleVisibility={() => toggleSecret("restApiKey")}
                            />
                          </Field>
                          <Field label="Swagger/OpenAPI URL (optional)">
                            <Input
                              value={restForm.specUrl}
                              onChange={(event) => setRestForm((prev) => ({ ...prev, specUrl: event.target.value }))}
                              placeholder="https://api.example.com/swagger.json"
                            />
                          </Field>
                        </div>
                      )}

                      {(selectedConnectionType === "postgresql" || selectedConnectionType === "mysql") && (
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label="Name">
                            <Input
                              value={sqlForm.name}
                              onChange={(event) => setSqlForm((prev) => ({ ...prev, name: event.target.value }))}
                              placeholder={selectedConnectionType === "postgresql" ? "Primary PostgreSQL" : "Primary MySQL"}
                            />
                          </Field>
                          <Field label="Host">
                            <Input
                              value={sqlForm.host}
                              onChange={(event) => setSqlForm((prev) => ({ ...prev, host: event.target.value }))}
                              placeholder="db.company.internal"
                            />
                          </Field>
                          <Field label="Port">
                            <Input
                              value={sqlForm.port}
                              onChange={(event) => setSqlForm((prev) => ({ ...prev, port: event.target.value }))}
                              placeholder={selectedConnectionType === "postgresql" ? "5432" : "3306"}
                            />
                          </Field>
                          <Field label="Database">
                            <Input
                              value={sqlForm.database}
                              onChange={(event) => setSqlForm((prev) => ({ ...prev, database: event.target.value }))}
                              placeholder="production"
                            />
                          </Field>
                          <Field label="Username">
                            <Input
                              value={sqlForm.username}
                              onChange={(event) => setSqlForm((prev) => ({ ...prev, username: event.target.value }))}
                              placeholder="db_user"
                            />
                          </Field>
                          <Field label="Password">
                            <SecretInput
                              value={sqlForm.password}
                              onChange={(value) => setSqlForm((prev) => ({ ...prev, password: value }))}
                              placeholder="Enter password"
                              visible={showSecrets.sqlPassword}
                              onToggleVisibility={() => toggleSecret("sqlPassword")}
                            />
                          </Field>
                          <div className="md:col-span-2 flex items-center gap-3">
                            <Switch
                              checked={sqlForm.ssl}
                              onCheckedChange={(checked) => setSqlForm((prev) => ({ ...prev, ssl: checked }))}
                            />
                            <span className="text-sm text-slate-700">Enable SSL</span>
                          </div>
                        </div>
                      )}

                      {selectedConnectionType === "mongodb" && (
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label="Name">
                            <Input
                              value={mongoForm.name}
                              onChange={(event) => setMongoForm((prev) => ({ ...prev, name: event.target.value }))}
                              placeholder="Mongo Atlas"
                            />
                          </Field>
                          <Field label="Connection String">
                            <SecretInput
                              value={mongoForm.connectionString}
                              onChange={(value) => setMongoForm((prev) => ({ ...prev, connectionString: value }))}
                              placeholder="mongodb+srv://user:pass@cluster.mongodb.net/db"
                              visible={showSecrets.mongoConn}
                              onToggleVisibility={() => toggleSecret("mongoConn")}
                            />
                          </Field>
                        </div>
                      )}

                      {selectedConnectionType === "google_sheets" && (
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label="Name">
                            <Input
                              value={sheetsForm.name}
                              onChange={(event) => setSheetsForm((prev) => ({ ...prev, name: event.target.value }))}
                              placeholder="Finance Planning Sheets"
                            />
                          </Field>
                          <Field label="Sheet URL">
                            <Input
                              value={sheetsForm.sheetUrl}
                              onChange={(event) => setSheetsForm((prev) => ({ ...prev, sheetUrl: event.target.value }))}
                              placeholder="https://docs.google.com/spreadsheets/d/..."
                            />
                          </Field>
                          <div className="md:col-span-2 space-y-2">
                            <Label>Service Account JSON</Label>
                            <div className="flex flex-wrap items-center gap-3">
                              <input
                                ref={serviceAccountInputRef}
                                type="file"
                                accept=".json,application/json"
                                className="hidden"
                                onChange={(event) => handleServiceAccountFile(event.target.files?.[0] ?? null)}
                              />
                              <Button type="button" variant="outline" onClick={() => serviceAccountInputRef.current?.click()}>
                                <CloudUpload className="h-4 w-4" />
                                Upload JSON
                              </Button>
                              <span className="text-sm text-slate-600">
                                {sheetsForm.serviceAccountFileName || "No file selected"}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      {selectedConnectionType === "notion" && (
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label="Name">
                            <Input
                              value={notionForm.name}
                              onChange={(event) => setNotionForm((prev) => ({ ...prev, name: event.target.value }))}
                              placeholder="Notion Ops Workspace"
                            />
                          </Field>
                          <Field label="Database ID">
                            <Input
                              value={notionForm.databaseId}
                              onChange={(event) => setNotionForm((prev) => ({ ...prev, databaseId: event.target.value }))}
                              placeholder="xxxxxxxxxxxxxxxx"
                            />
                          </Field>
                          <div className="md:col-span-2">
                            <Field label="Integration Token">
                              <SecretInput
                                value={notionForm.integrationToken}
                                onChange={(value) => setNotionForm((prev) => ({ ...prev, integrationToken: value }))}
                                placeholder="secret_..."
                                visible={showSecrets.notionToken}
                                onToggleVisibility={() => toggleSecret("notionToken")}
                              />
                            </Field>
                          </div>
                        </div>
                      )}

                      {selectedConnectionType === "custom_rest" && (
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label="Name">
                            <Input
                              value={customRestForm.name}
                              onChange={(event) => setCustomRestForm((prev) => ({ ...prev, name: event.target.value }))}
                              placeholder="Legacy Internal API"
                            />
                          </Field>
                          <Field label="Base URL">
                            <Input
                              value={customRestForm.baseUrl}
                              onChange={(event) => setCustomRestForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                              placeholder="https://legacy-api.company.com"
                            />
                          </Field>
                          <div className="md:col-span-2">
                            <Field label="API Key">
                              <SecretInput
                                value={customRestForm.apiKey}
                                onChange={(value) => setCustomRestForm((prev) => ({ ...prev, apiKey: value }))}
                                placeholder="Paste API key"
                                visible={showSecrets.customApiKey}
                                onToggleVisibility={() => toggleSecret("customApiKey")}
                              />
                            </Field>
                          </div>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" variant="outline" onClick={handleTestConnection} disabled={testingConnection}>
                          {testingConnection ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Testing...
                            </>
                          ) : (
                            <>
                              <KeyRound className="h-4 w-4" />
                              Test Connection
                            </>
                          )}
                        </Button>
                        {testOutcome.status !== "idle" && (
                          <span
                            className={cn(
                              "text-sm font-medium",
                              testOutcome.status === "success" ? "text-emerald-700" : "text-rose-700",
                            )}
                          >
                            {testOutcome.message}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {analysisVisible && (
                    <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
                      <div className="flex items-start gap-2">
                        <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-violet-700" />
                        <div>
                          <p className="text-sm font-semibold text-violet-900">Background analysis queued</p>
                          <p className="mt-1 text-sm text-violet-800">{analysisMessage}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={goToPrevStep}>
                      Back
                    </Button>
                    <Button
                      onClick={continueFromDataStep}
                      className="bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
                      disabled={testingConnection || savingDataConnection || testOutcome.status !== "success"}
                    >
                      {savingDataConnection ? "Saving..." : "Continue"}
                      {!savingDataConnection && <ArrowRight className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              )}

              {currentStep === 4 && (
                <div className="space-y-6">
                  <div className="relative overflow-hidden rounded-2xl border border-violet-200 bg-gradient-to-r from-violet-50 to-indigo-50 p-6 text-center">
                    {showConfettiFallback && (
                      <div className="pointer-events-none absolute inset-0">
                        {["🎉", "✨", "🎊", "🚀", "✨", "🎉"].map((emoji, idx) => (
                          <motion.span
                            key={`${emoji}-${idx}`}
                            initial={{ opacity: 0, y: 30, x: 0 }}
                            animate={{ opacity: [0, 1, 0], y: -40, x: (idx - 2) * 22 }}
                            transition={{ duration: 1.2, delay: idx * 0.06 }}
                            className="absolute left-1/2 top-16 text-xl"
                          >
                            {emoji}
                          </motion.span>
                        ))}
                      </div>
                    )}
                    <span className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg">
                      <Sparkles className="h-7 w-7" />
                    </span>
                    <h2 className="text-3xl font-bold text-slate-900">Your AI workspace is ready!</h2>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-3">
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Connected Sources</p>
                      <p className="mt-2 text-2xl font-bold text-slate-900">{connectedSources.length}</p>
                      <div className="mt-3 space-y-1">
                        {connectedSources.length > 0 ? (
                          connectedSources.slice(0, 3).map((source) => (
                            <p key={source.id} className="truncate text-sm text-slate-600">
                              {source.name}
                            </p>
                          ))
                        ) : (
                          <p className="text-sm text-slate-500">No sources detected yet.</p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Team Members</p>
                      <p className="mt-2 text-2xl font-bold text-slate-900">{teamMembers.length}</p>
                      <div className="mt-3 flex items-center gap-2">
                        {teamMembers.length > 0 ? (
                          teamMembers.slice(0, 5).map((member) => (
                            <span
                              key={member.id}
                              title={member.label}
                              className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-slate-300 bg-slate-100 text-xs font-semibold text-slate-700"
                            >
                              {member.avatarUrl ? (
                                <img
                                  src={member.avatarUrl}
                                  alt={member.label}
                                  loading="lazy"
                                  decoding="async"
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                initialsFromLabel(member.label)
                              )}
                            </span>
                          ))
                        ) : (
                          <p className="text-sm text-slate-500">Only you for now.</p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">AI Agents Ready</p>
                      <p className="mt-2 text-2xl font-bold text-slate-900">{workspaceAgents.length}</p>
                      <p className="mt-3 text-sm text-slate-600">
                        {workspaceAgents.length > 0
                          ? `${workspaceAgents.length} agent${workspaceAgents.length > 1 ? "s" : ""} auto-generated`
                          : "No agents generated yet"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-violet-700">
                        {workspaceAgents.length > 0 ? (
                          workspaceAgents.slice(0, 4).map((agent) => (
                            <span key={agent.id} className="rounded-full bg-violet-100 px-2.5 py-1">
                              {agent.name}
                            </span>
                          ))
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Pending generation</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-5">
                    <div className="mb-3 flex items-center gap-2">
                      <Bot className="h-5 w-5 text-violet-700" />
                      <h3 className="text-lg font-semibold text-slate-900">RACI Quick Setup</h3>
                    </div>
                    <div className="space-y-3">
                      {raciSuggestions.map((rule) => (
                        <div key={rule.id} className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <p className="text-sm text-slate-700">{rule.summary}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-slate-500">Apply</span>
                            <Switch checked={rule.enabled} onCheckedChange={(checked) => toggleRaciSuggestion(rule.id, checked)} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                    <h4 className="font-semibold text-blue-900">What happens next</h4>
                    <ul className="mt-2 space-y-1.5 text-sm text-blue-800">
                      <li>{launchPipelineStatus.schema}</li>
                      <li>{launchPipelineStatus.email}</li>
                      <li>{launchPipelineStatus.rag}</li>
                    </ul>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={() => activateTenantAndLaunch("dashboard")}
                      className="bg-gradient-to-r from-violet-700 to-purple-600 text-white hover:opacity-95"
                      disabled={launchingDestination !== null || loadingLaunchSummary}
                    >
                      {launchingDestination === "dashboard" ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Launching...
                        </>
                      ) : (
                        "Go to Dashboard"
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => activateTenantAndLaunch("raci")}
                      disabled={launchingDestination !== null || loadingLaunchSummary}
                    >
                      {launchingDestination === "raci" ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Configure RACI Now"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SecretInput({
  value,
  onChange,
  placeholder,
  visible,
  onToggleVisibility,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  visible: boolean;
  onToggleVisibility: () => void;
}) {
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="pr-11"
      />
      <button
        type="button"
        onClick={onToggleVisibility}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
