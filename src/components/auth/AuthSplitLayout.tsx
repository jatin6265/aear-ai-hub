import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Bot } from "lucide-react";

type AuthSplitLayoutProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
};

export default function AuthSplitLayout({ title, subtitle, children }: AuthSplitLayoutProps) {
  return (
    <div className="min-h-screen bg-slate-100 lg:grid lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-[#2E1065] via-[#5B21B6] to-[#7C3AED] p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-12 -left-10 h-64 w-64 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-fuchsia-300/20 blur-3xl" />
        </div>
        <Link to="/" className="relative z-10 inline-flex items-center gap-3 text-white">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
            <Bot className="h-5 w-5" />
          </span>
          <span className="text-xl font-semibold tracking-tight">OpsAI</span>
        </Link>

        <div className="relative z-10 max-w-lg">
          <p className="mb-4 inline-block rounded-full border border-white/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white/90">
            Enterprise AI Security First
          </p>
          <h1 className="text-4xl font-bold leading-tight text-white">Your Enterprise AI Operating Layer</h1>
          <p className="mt-5 text-lg text-white/85">
            Connect any API or database. Auto-build RAG pipelines. Enforce RACI governance. Execute safely.
          </p>
        </div>
        <p className="relative z-10 text-sm text-white/70">OpsAI protects critical actions with policy-native AI orchestration.</p>
      </aside>

      <main className="flex items-center justify-center p-6 lg:p-10">
        <div className="w-full max-w-md">
          <div className="mb-6 lg:hidden">
            <Link to="/" className="inline-flex items-center gap-2 text-slate-900">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-[#5B21B6] to-[#7C3AED] text-white">
                <Bot className="h-4 w-4" />
              </span>
              <span className="text-lg font-semibold">OpsAI</span>
            </Link>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/80 transition-all duration-300">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h2>
            <p className="mt-2 text-sm text-slate-600">{subtitle}</p>
            <div className="mt-7">{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
