import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  Landmark,
  Loader2,
  PencilLine,
  Search,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import SimulationPreview from "@/components/SimulationPreview";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
type ApprovalType = "update" | "delete" | "financial" | "report";
type RiskLevel = "low" | "medium" | "high" | "critical";
type StatusFilter = "all" | ApprovalStatus;

type ApprovalRow = {
  id: string;
  type: ApprovalType;
  actionSummary: string;
  action: string;
  resource: string;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string | null;
  expiresInSeconds: number | null;
  requestedById: string;
  requestedByName: string;
  requestedByRole: string;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  canReview: boolean;
  isResponsible: boolean;
  params: Record<string, unknown> | null;
  simulationPreview: Record<string, unknown> | null;
  requiredApprovals?: number;
  approvedCount?: number;
  rejectedCount?: number;
  pendingApprovals?: number;
  myDecision?: string | null;
};

type QueuePayload = {
  profileRole: string;
  isAccountable: boolean;
  counts: {
    all: number;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
  };
  pendingNeedingDecision: number;
  rows: ApprovalRow[];
};

type ReviewDetail = {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  riskLevel: RiskLevel;
  actionSummary: string;
  action: string;
  resource: string;
  targetIdentifier: string;
  requestedAt: string;
  expiresAt: string | null;
  expiresInSeconds: number | null;
  requestedBy: {
    id: string;
    name: string;
    role: string;
    avatarUrl: string | null;
    email: string;
  };
  decidedBy: {
    id: string;
    name: string;
  } | null;
  decidedAt: string | null;
  canReview: boolean;
  isAccountable: boolean;
  raciConfirmation: string;
  requestExplanation: string | null;
  simulationPreview: Record<string, unknown> | null;
  executionHistory: {
    count: number;
    recent: Array<{
      id: string;
      status: string;
      riskLevel: RiskLevel;
      createdAt: string;
      actorName: string;
    }>;
  };
  approvalProgress?: {
    requiredApprovals?: number;
    approvedCount?: number;
    rejectedCount?: number;
    pendingApprovals?: number;
    myDecision?: string | null;
  };
};

type ReviewDecisionResult = {
  status: string;
  decidedAt: string | null;
  token: string | null;
  tokenPrefix?: string | null;
  tokenExpiresAt: string | null;
  message: string | null;
  requiredApprovals?: number;
  approvedCount?: number;
  rejectedCount?: number;
  pendingApprovals?: number;
  reviewerDecision?: string;
};

const EMPTY_PAYLOAD: QueuePayload = {
  profileRole: "member",
  isAccountable: false,
  counts: {
    all: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
  },
  pendingNeedingDecision: 0,
  rows: [],
};

function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hr ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`;

  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} year${diffYears === 1 ? "" : "s"} ago`;
}

function formatExpiry(seconds: number | null) {
  if (seconds === null) return null;
  if (seconds <= 0) return "Expired";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `Expires in ${hours}h ${minutes}m`;
}

function riskBadgeClass(level: RiskLevel) {
  if (level === "critical") return "border-slate-900 bg-slate-900 text-white";
  if (level === "high") return "border-red-200 bg-red-100 text-red-800";
  if (level === "medium") return "border-amber-200 bg-amber-100 text-amber-800";
  return "border-emerald-200 bg-emerald-100 text-emerald-800";
}

function statusBadgeClass(status: ApprovalStatus) {
  if (status === "pending") return "border-amber-200 bg-amber-100 text-amber-800";
  if (status === "approved") return "border-emerald-200 bg-emerald-100 text-emerald-800";
  if (status === "rejected") return "border-red-200 bg-red-100 text-red-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function typeIcon(type: ApprovalType) {
  if (type === "delete") return <Trash2 className="h-4 w-4 text-red-600" />;
  if (type === "financial") return <Landmark className="h-4 w-4 text-violet-600" />;
  if (type === "report") return <FileText className="h-4 w-4 text-slate-600" />;
  return <PencilLine className="h-4 w-4 text-blue-600" />;
}

function typeLabel(type: ApprovalType) {
  if (type === "delete") return "Delete";
  if (type === "financial") return "Financial";
  if (type === "report") return "Report";
  return "Update";
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "U"
  );
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function Approvals() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [payload, setPayload] = useState<QueuePayload>(EMPTY_PAYLOAD);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"all" | RiskLevel>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewDetail, setReviewDetail] = useState<ReviewDetail | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [decisionResult, setDecisionResult] = useState<ReviewDecisionResult | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 260);

    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (!user) {
      setTenantId(null);
      setPayload(EMPTY_PAYLOAD);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (!cancelled) setTenantId(workspace.tenantId);
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        toast({
          title: "Could not load workspace",
          description: error instanceof Error ? error.message : "Please refresh and try again.",
          variant: "destructive",
        });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [toast, user]);

  const loadQueue = useCallback(
    async (withLoading = true) => {
      if (!tenantId) return;

      if (withLoading) setLoading(true);

      try {
        const { data, error } = await invokeEdge("approvals-queue", {
          body: {
            operation: "get_payload",
            statusFilter,
            search: searchQuery,
            riskFilter,
            dateFrom: dateFrom || null,
            dateTo: dateTo || null,
          },
        });

        if (error) throw error;
        setPayload((data?.payload as QueuePayload) ?? EMPTY_PAYLOAD);
      } catch (error) {
        toast({
          title: "Could not load approvals",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        if (withLoading) setLoading(false);
      }
    },
    [dateFrom, dateTo, riskFilter, searchQuery, statusFilter, tenantId, toast],
  );

  useEffect(() => {
    if (!tenantId) return;
    void loadQueue(true);
  }, [loadQueue, tenantId]);

  useEffect(() => {
    if (!tenantId) return;

    const channel = supabase
      .channel(`approvals-queue-${tenantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "approval_requests",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void loadQueue(false);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadQueue, tenantId]);

  const openReviewModal = async (approvalId: string) => {
    setReviewDialogOpen(true);
    setReviewLoading(true);
    setReviewDetail(null);
    setReviewReason("");
    setDecisionResult(null);

    try {
      const { data, error } = await invokeEdge("approvals-queue", {
        body: {
          operation: "get_review_detail",
          approvalId,
        },
      });

      if (error) throw error;
      setReviewDetail((data?.review as ReviewDetail) ?? null);
    } catch (error) {
      toast({
        title: "Could not load review details",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
      setReviewDialogOpen(false);
    } finally {
      setReviewLoading(false);
    }
  };

  const reviewDecide = async (decision: "approved" | "rejected" | "more_info") => {
    if (!reviewDetail) return;

    if ((decision === "rejected" || decision === "more_info") && reviewReason.trim().length < 3) {
      toast({
        title: decision === "rejected" ? "Rejection reason required" : "Message required",
        description: "Please provide at least 3 characters.",
        variant: "destructive",
      });
      return;
    }

    setActingId(reviewDetail.id);

    try {
      const { data, error } = await invokeEdge("approvals-queue", {
        body: {
          operation: "review_decide",
          approvalId: reviewDetail.id,
          decision,
          reason: reviewReason.trim() || null,
          statusFilter,
          search: searchQuery,
          riskFilter,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
        },
      });

      if (error) throw error;

      setPayload((data?.payload as QueuePayload) ?? EMPTY_PAYLOAD);
      setReviewDetail((data?.review as ReviewDetail) ?? reviewDetail);
      setDecisionResult((data?.result as ReviewDecisionResult) ?? null);

      toast({
        title:
          decision === "approved"
            ? "Approval granted"
            : decision === "rejected"
              ? "Approval rejected"
              : "More info requested",
        description: "Request updated and notification queued.",
      });
    } catch (error) {
      toast({
        title: "Could not submit decision",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setActingId(null);
    }
  };

  const rows = payload.rows;

  const tabCounts = useMemo(
    () => [
      { value: "all" as const, label: "All", count: payload.counts.all },
      { value: "pending" as const, label: "Pending", count: payload.counts.pending },
      { value: "approved" as const, label: "Approved", count: payload.counts.approved },
      { value: "rejected" as const, label: "Rejected", count: payload.counts.rejected },
      { value: "expired" as const, label: "Expired", count: payload.counts.expired },
    ],
    [payload.counts],
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
            <Badge variant="outline" className="border-amber-200 bg-amber-100 text-amber-800">
              {payload.counts.pending} pending
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Review and govern high-risk actions before execution.</p>
        </div>
      </div>

      {payload.pendingNeedingDecision > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">
            You have {payload.pendingNeedingDecision} approval{payload.pendingNeedingDecision === 1 ? "" : "s"} requiring your decision
          </span>
          {payload.isAccountable ? " as an Accountable reviewer." : "."}
        </div>
      ) : null}

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <Tabs value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
          <TabsList className="w-full justify-start overflow-auto">
            {tabCounts.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-2">
                {tab.label}
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{tab.count}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="grid gap-3 md:grid-cols-[1fr_160px_140px_140px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by action or user"
              className="pl-10"
            />
          </div>

          <Select value={riskFilter} onValueChange={(value) => setRiskFilter(value as "all" | RiskLevel)}>
            <SelectTrigger>
              <SelectValue placeholder="Risk" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All risks</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>

          <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="hidden md:table-cell">Type</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Requested By</TableHead>
              <TableHead className="hidden md:table-cell">Resource</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead className="hidden md:table-cell">Requested At</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 7 }).map((_, index) => (
                <TableRow key={`approval-skeleton-${index}`}>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-5 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-56" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><div className="ml-auto w-fit"><Skeleton className="h-8 w-20" /></div></TableCell>
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="px-4 py-14 text-center">
                  <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-slate-500">
                    <CheckCircle2 className="h-9 w-9 text-emerald-500" />
                    <p className="text-sm font-medium text-slate-700">No pending approvals</p>
                    <p className="text-xs">Everything is clear for the selected filters.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const expiryLabel = row.status === "pending" ? formatExpiry(row.expiresInSeconds) : null;
                const expiryUrgent = row.status === "pending" && (row.expiresInSeconds ?? 0) > 0 && (row.expiresInSeconds ?? 0) < 7200;

                return (
                  <TableRow key={row.id}>
                    <TableCell className="hidden md:table-cell">
                      <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700">
                        {typeIcon(row.type)}
                        {typeLabel(row.type)}
                      </div>
                    </TableCell>
                    <TableCell><p className="max-w-[280px] truncate font-medium text-slate-900">{row.actionSummary}</p></TableCell>
                    <TableCell><p className="font-medium text-slate-800">{row.requestedByName}</p></TableCell>
                    <TableCell className="hidden md:table-cell"><p className="text-slate-700">{row.resource}</p></TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("uppercase", riskBadgeClass(row.riskLevel))}>{row.riskLevel}</Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <p className="text-slate-700">{formatRelativeTime(row.requestedAt)}</p>
                      {expiryLabel ? (
                        <p className={cn("mt-1 inline-flex items-center gap-1 text-xs", expiryUrgent ? "text-orange-600" : "text-slate-500")}>
                          <Clock3 className="h-3.5 w-3.5" />
                          {expiryLabel}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("capitalize", statusBadgeClass(row.status))}>{row.status}</Badge>
                      {row.status === "pending" && typeof row.requiredApprovals === "number" ? (
                        <p className="mt-1 text-xs text-slate-500">
                          {Math.max(0, Number(row.approvedCount ?? 0))}/{Math.max(1, Number(row.requiredApprovals ?? 1))} approvals
                          {typeof row.pendingApprovals === "number"
                            ? ` · ${Math.max(0, Number(row.pendingApprovals))} remaining`
                            : ""}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" className="md:hidden" onClick={() => void openReviewModal(row.id)}>
                          View details
                        </Button>
                        <div className="hidden md:flex">
                          {row.status === "pending" && row.canReview ? (
                            <Button
                              size="sm"
                              className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700"
                              onClick={() => void openReviewModal(row.id)}
                            >
                              Review
                            </Button>
                          ) : row.status === "pending" && row.isResponsible ? (
                            <Button size="sm" variant="outline" className="border-slate-300 text-slate-600" onClick={() => void openReviewModal(row.id)}>
                              View status
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => void openReviewModal(row.id)}>
                              View
                            </Button>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <Dialog
        open={reviewDialogOpen}
        onOpenChange={(open) => {
          setReviewDialogOpen(open);
          if (!open) {
            setReviewDetail(null);
            setReviewReason("");
            setDecisionResult(null);
          }
        }}
      >
        <DialogContent className="max-w-[720px]">
          {reviewLoading ? (
            <div className="space-y-3 py-4">
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : reviewDetail ? (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <DialogTitle>Review Action Request</DialogTitle>
                    <DialogDescription className="mt-1">
                      Requested {formatRelativeTime(reviewDetail.requestedAt)}
                    </DialogDescription>
                  </div>
                  <Badge variant="outline" className={cn("px-3 py-1 text-sm uppercase", riskBadgeClass(reviewDetail.riskLevel))}>
                    {reviewDetail.riskLevel}
                  </Badge>
                </div>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <Avatar className="h-10 w-10">
                    <AvatarImage src={reviewDetail.requestedBy.avatarUrl ?? undefined} alt={reviewDetail.requestedBy.name} />
                    <AvatarFallback>{initials(reviewDetail.requestedBy.name)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-semibold text-slate-900">{reviewDetail.requestedBy.name}</p>
                    <p className="text-xs text-slate-600">
                      {reviewDetail.requestedBy.role} · {new Date(reviewDetail.requestedAt).toLocaleString()}
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">What</p>
                    <p className="mt-1 font-medium text-slate-900">{reviewDetail.actionSummary}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resource</p>
                    <p className="mt-1 text-slate-800">{reviewDetail.resource}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Target</p>
                    <p className="mt-1 text-slate-800">{reviewDetail.targetIdentifier || "N/A"}</p>
                  </div>
                </div>

                <SimulationPreview
                  action={{
                    action: reviewDetail.actionSummary,
                    resource: reviewDetail.resource,
                    riskLevel: reviewDetail.riskLevel,
                    simulation: reviewDetail.simulationPreview,
                    params: { targetIdentifier: reviewDetail.targetIdentifier },
                  }}
                />

                <section className="rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-700">Context</h3>
                  <div className="mt-2 space-y-2 text-xs text-slate-700">
                    <p>
                      <span className="font-semibold">Why requested:</span>{" "}
                      {reviewDetail.requestExplanation || "No explicit explanation provided by requestor."}
                    </p>
                    <p>
                      <span className="font-semibold">Execution history:</span>{" "}
                      {reviewDetail.executionHistory.count} similar action{reviewDetail.executionHistory.count === 1 ? "" : "s"} found.
                    </p>
                    {reviewDetail.executionHistory.recent.length > 0 ? (
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                        {reviewDetail.executionHistory.recent.map((item) => (
                          <p key={item.id} className="text-[11px] text-slate-600">
                            {formatRelativeTime(item.createdAt)} · {item.actorName} · {item.status}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    <p>
                      <span className="font-semibold">RACI confirmation:</span> {reviewDetail.raciConfirmation}
                    </p>
                    {reviewDetail.approvalProgress ? (
                      <p>
                        <span className="font-semibold">Approval progress:</span>{" "}
                        {Number(reviewDetail.approvalProgress.approvedCount ?? 0)}/
                        {Math.max(1, Number(reviewDetail.approvalProgress.requiredApprovals ?? 1))} approved
                        {typeof reviewDetail.approvalProgress.pendingApprovals === "number"
                          ? ` · ${Math.max(0, Number(reviewDetail.approvalProgress.pendingApprovals))} remaining`
                          : ""}
                      </p>
                    ) : null}
                  </div>
                </section>

                {reviewDetail.status === "pending" && reviewDetail.canReview ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Decision note / rejection reason / more info message
                    </p>
                    <Textarea
                      rows={3}
                      value={reviewReason}
                      onChange={(event) => setReviewReason(event.target.value)}
                      placeholder="Required for Reject and Request More Info"
                    />
                  </div>
                ) : null}

                <AnimatePresence>
                  {decisionResult ? (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"
                    >
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
                        <div className="text-sm text-emerald-900">
                          <p className="font-semibold">{decisionResult.message || "Decision submitted"}</p>
                          {decisionResult.token ? (
                            <p className="mt-1 text-xs">
                              Execution token (15 min): <code className="rounded bg-emerald-100 px-1 py-0.5">{decisionResult.token}</code>
                            </p>
                          ) : null}
                          {decisionResult.tokenExpiresAt ? (
                            <p className="mt-1 text-xs">Token expires at: {new Date(decisionResult.tokenExpiresAt).toLocaleString()}</p>
                          ) : null}
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Raw request payload</p>
                  <pre className="mt-1 max-h-36 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
                    {prettyJson(reviewDetail.simulationPreview ?? {})}
                  </pre>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setReviewDialogOpen(false)}>
                  Close
                </Button>

                {reviewDetail.status === "pending" && reviewDetail.canReview ? (
                  <>
                    <Button
                      variant="outline"
                      className="border-slate-300 text-slate-700"
                      onClick={() => void reviewDecide("more_info")}
                      disabled={actingId === reviewDetail.id}
                    >
                      {actingId === reviewDetail.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Request More Info
                    </Button>
                    <Button
                      variant="outline"
                      className="border-red-200 text-red-700 hover:bg-red-50"
                      onClick={() => void reviewDecide("rejected")}
                      disabled={actingId === reviewDetail.id}
                    >
                      {actingId === reviewDetail.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                      Reject
                    </Button>
                    <Button
                      className="min-w-[220px] bg-emerald-600 text-white hover:bg-emerald-700"
                      onClick={() => void reviewDecide("approved")}
                      disabled={actingId === reviewDetail.id}
                    >
                      {actingId === reviewDetail.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                      Approve & Issue Token
                    </Button>
                  </>
                ) : null}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {payload.counts.pending > 0 && !payload.isAccountable ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Pending approvals exist, but your role is not Accountable for decisioning. You can monitor status from this queue.
        </div>
      ) : null}
    </div>
  );
}
