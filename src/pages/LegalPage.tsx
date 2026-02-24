import { Link, useParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

const LEGAL_CONTENT: Record<string, { title: string; body: string[] }> = {
  terms: {
    title: "Terms of Service",
    body: [
      "AEAR provides an enterprise AI operating layer for governed data and action workflows.",
      "By using the service, you agree to follow your organization's policy controls, RACI governance assignments, and applicable regulations.",
      "You are responsible for maintaining secure credentials for connected systems and for reviewing approval-gated actions before execution.",
    ],
  },
  privacy: {
    title: "Privacy Policy",
    body: [
      "AEAR processes tenant-isolated metadata, usage telemetry, and configured connection payloads to provide product functionality.",
      "Sensitive fields should be protected using guardrails, masking policies, and role-based access controls configured by your organization.",
      "For support inquiries related to privacy and data handling, contact your workspace administrator.",
    ],
  },
  security: {
    title: "Security",
    body: [
      "AEAR uses Supabase auth, row-level security, and governed execution policies to protect tenant boundaries.",
      "Critical and destructive actions should be approval-gated and audited using the RACI and guardrails modules.",
      "Keep worker tokens, API keys, and integration secrets rotated and stored through secure secrets management.",
    ],
  },
};

export default function LegalPage() {
  const { doc = "terms" } = useParams();
  const content = LEGAL_CONTENT[doc] ?? LEGAL_CONTENT.terms;

  return (
    <main className="min-h-screen bg-[#1A1A2E] text-white">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Link to="/" className="text-sm text-white/70 hover:text-white">
          Back to home
        </Link>

        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-8">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-200">
            <ShieldCheck className="h-3.5 w-3.5" />
            AEAR Legal
          </div>
          <h1 className="text-3xl font-bold">{content.title}</h1>
          <div className="mt-6 space-y-4 text-sm leading-relaxed text-white/85">
            {content.body.map((paragraph, index) => (
              <p key={`${doc}-paragraph-${index}`}>{paragraph}</p>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
