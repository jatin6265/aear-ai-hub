import { MessageCircle, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type WidgetBubbleSize = "small" | "medium" | "large";
export type WidgetPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export type WidgetPreviewConfig = {
  position: WidgetPosition;
  primaryColor: string;
  buttonSize: WidgetBubbleSize;
  initialMessage: string;
  tenantName: string;
  enabledAgentNames: string[];
  accessMode: "public" | "authenticated" | "jwt";
  features: {
    chat: boolean;
    executeActions: boolean;
    viewReports: boolean;
    requestApprovals: boolean;
  };
};

const BUBBLE_SIZE_CLASS: Record<WidgetBubbleSize, string> = {
  small: "h-10 w-10",
  medium: "h-12 w-12",
  large: "h-14 w-14",
};

const POSITION_CLASS: Record<WidgetPosition, string> = {
  "bottom-right": "bottom-4 right-4",
  "bottom-left": "bottom-4 left-4",
  "top-right": "top-4 right-4",
  "top-left": "top-4 left-4",
};

const PANEL_POSITION_CLASS: Record<WidgetPosition, string> = {
  "bottom-right": "bottom-20 right-4",
  "bottom-left": "bottom-20 left-4",
  "top-right": "top-20 right-4",
  "top-left": "top-20 left-4",
};

type Props = {
  config: WidgetPreviewConfig;
  open: boolean;
  onToggle: () => void;
  className?: string;
};

export function WidgetPreviewMock({ config, open, onToggle, className }: Props) {
  return (
    <div className={cn("relative h-[520px] overflow-hidden rounded-2xl border border-slate-300 bg-slate-100", className)}>
      <div className="border-b border-slate-300 bg-slate-200 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="ml-2 text-[11px] text-slate-500">https://app.example.com</span>
        </div>
      </div>

      <div className="absolute inset-0 top-[37px] bg-gradient-to-b from-slate-50 to-white p-6">
        <div className="h-40 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-400">Website content mockup</p>
          <h3 className="mt-2 text-sm font-semibold text-slate-700">Need help with something?</h3>
          <p className="mt-1 text-xs text-slate-500">
            The widget appears in the selected corner. Click the bubble to open chat.
          </p>
        </div>
      </div>

      {open ? (
        <div
          className={cn(
            "absolute z-10 w-[310px] rounded-xl border border-slate-200 bg-white shadow-2xl",
            PANEL_POSITION_CLASS[config.position],
          )}
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <div>
              <p className="text-sm font-semibold text-slate-800">OpsAI Assistant</p>
              <p className="text-[11px] text-slate-500">{config.tenantName}</p>
            </div>
            <button type="button" onClick={onToggle} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3 px-3 py-3">
            <div className="max-w-[90%] rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
              {config.initialMessage || "How can I help you today?"}
            </div>
            <div className="max-w-[90%] rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
              Enabled agents: {config.enabledAgentNames.length > 0 ? config.enabledAgentNames.join(", ") : "All available"}
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-[11px] text-slate-600">
              Mode: {config.accessMode} · Actions: {config.features.executeActions ? "on" : "off"} · Reports:{" "}
              {config.features.viewReports ? "on" : "off"}
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-slate-200 px-3 py-2">
            <div className="h-8 flex-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-400">
              Ask the assistant...
            </div>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-white"
              style={{ backgroundColor: config.primaryColor }}
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "absolute z-20 inline-flex items-center justify-center rounded-full text-white shadow-xl transition hover:scale-[1.02]",
          BUBBLE_SIZE_CLASS[config.buttonSize],
          POSITION_CLASS[config.position],
        )}
        style={{ backgroundColor: config.primaryColor }}
      >
        <MessageCircle className="h-5 w-5" />
      </button>
    </div>
  );
}

