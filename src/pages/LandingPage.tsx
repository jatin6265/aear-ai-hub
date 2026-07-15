import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Zap, Shield, Brain, Eye, Lock, RefreshCw, ArrowRight, Check, Plug, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
// ─── Brand palette (sourced from OpsAI_Logo_01.svg) ──────────────────────────
const NAVY  = '#12294A';   // logo body colour
const TEAL  = '#4FDEAA';   // logo "AI" colour / ring arcs
const NAVY2 = '#0d1f38';   // slightly darker navy for footer
const TEAL_DIM = '#0e9065'; // darker teal for use on light backgrounds
const WHITISH = '#ffffff'; // white tone
// ─────────────────────────────────────────────────────────────────────────────

const features = [
  { icon: Zap,       title: 'Auto-Discovery',      desc: 'Connect any API via URL. Zero manual mapping.' },
  { icon: Shield,    title: 'RACI Governance',      desc: 'Enforce org hierarchy. Not everyone can do everything.' },
  { icon: Brain,     title: 'Smart Agents',         desc: 'Domain AI agents built automatically from your schema.' },
  { icon: Eye,       title: 'Predictive AI',        desc: 'Surface insights before problems happen.' },
  { icon: Lock,      title: 'Critical Protection',  desc: 'Block destructive actions. Multi-approval workflows.' },
  { icon: RefreshCw, title: 'Live Sync',            desc: 'Real-time data sync. Always fresh RAG responses.' },
];

const steps = [
  { num: '01', icon: Plug,        title: 'Connect',          desc: 'Paste your API URL or DB connection.' },
  { num: '02', icon: Search,      title: 'Discover',         desc: 'AI maps your entire data structure automatically.' },
  { num: '03', icon: ShieldCheck, title: 'Govern & Execute', desc: "Chat, query, act — all within your org's rules." },
];

const pricing = [
  { name: 'Starter',    price: '$49',    period: '/mo', desc: 'For small teams getting started',   features: ['5 API connections', '1,000 AI calls/mo', '3 team members', 'Email support'],                                       cta: 'Start Free',       highlighted: false },
  { name: 'Pro',        price: '$299',   period: '/mo', desc: 'For growing organizations',          features: ['Unlimited connections', '25,000 AI calls/mo', '25 team members', 'RACI governance', 'Priority support'],           cta: 'Start Free Trial', highlighted: true  },
  { name: 'Enterprise', price: 'Custom', period: '',    desc: 'For large-scale deployments',        features: ['Everything in Pro', 'Unlimited AI calls', 'SSO & SAML', 'Dedicated support', 'Custom SLA'],                       cta: 'Contact Sales',    highlighted: false },
];

const fadeUp = {
  hidden:  { opacity: 0, y: 30 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1, duration: 0.5, ease: [0, 0, 0.2, 1] as const } }),
};

const logos = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Stark Ind.'];

/**
 * OpsAI_Logo_01.svg inlined as a React component.
 * viewBox cropped to the actual content (icon + "OpsAI" text).
 * opsColor: fill for the icon body and "Ops" text.
 *   - dark backgrounds  → 'white'
 *   - light backgrounds → '#12294A'
 */
function OpsAILogo({
  height = 36,
  opsColor = '#ffffff',
  // opsColor = NAVY,
}: {
  height?: number;
  opsColor?: string;
}) {
  return (
    <svg
      viewBox="90 95 595 160"
      height={height}
      style={{ display: 'block', overflow: 'visible' }}
      aria-label="OpsAI"
    >
      <defs>
        <clipPath id="logo-teal-clip">
          {/* Clip teal arcs to the upper-right quadrant of the icon */}
          <rect x="215" y="0" width="200" height="185" />
        </clipPath>
      </defs>

      {/* Icon body — pac-man arc shape (exact paths from OpsAI_Logo_01.svg) */}
      <path
        d="M 200 100 A 100 100 0 1 0 300 200 L 260 200 A 60 60 0 1 1 200 140 Z"
        fill={opsColor}
      />

      {/* Teal concentric ring arcs clipped to upper-right */}
      <circle cx="200" cy="200" r="67.5"  fill="none" stroke="#4FDEAA" strokeWidth="15" clipPath="url(#logo-teal-clip)" />
      <circle cx="200" cy="200" r="92.5"  fill="none" stroke="#4FDEAA" strokeWidth="15" clipPath="url(#logo-teal-clip)" />

      {/* "OpsAI" logotype — exact position from OpsAI_Logo_01.svg */}
      <text
        x="340" y="242"
        fontFamily="Montserrat, Inter, system-ui, sans-serif"
        fontWeight="700"
        fontSize="130"
      >
        <tspan fill={opsColor}>Ops</tspan>
        <tspan fill="#4FDEAA">AI</tspan>
      </text>
    </svg>
  );
}

function LogoIcon({ height = 30, opsColor = "#ffffff" }) {
  return (
    <svg
      viewBox="90 95 220 160" // 
      height={height}
      style={{ display: "block", overflow:'visible' }}
    >
      <defs>
        <clipPath id="logo-teal-clip">
          <rect x="215" y="0" width="200" height="185" />
        </clipPath>
      </defs>

      <path
        d="M 200 100 A 100 100 0 1 0 300 200 L 260 200 A 60 60 0 1 1 200 140 Z"
        fill={opsColor}
      />

      <circle cx="200" cy="200" r="67.5" fill="none" stroke="#4FDEAA" strokeWidth="15" clipPath="url(#logo-teal-clip)" />
      <circle cx="200" cy="200" r="92.5" fill="none" stroke="#4FDEAA" strokeWidth="15" clipPath="url(#logo-teal-clip)" />
    </svg>
  );
}

export default function LandingPage() {
  let [isMobile, setMobile] = useState(window.innerWidth < 450);
  return (
    <div className="overflow-hidden" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* ── Nav ─────────────────────────────────────────────────────────────── */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 border-b"
        style={{
          // marginLeft:'30px',
          width: '70%',
          marginLeft:'15%',
          borderRadius:'60px',
          marginTop:'1%',
          padding:'0 2%',
          background: 'rgba(13, 22, 37, 0.48)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderColor: 'rgba(79,222,170,0.2)',
          boxShadow: '0 1px 40px rgba(18,41,74,0.6), inset 0 -1px 0 rgba(79,222,170,0.12)',
        }}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Brand — real OpsAI_Logo_01.svg (white on dark nav) */}
          <div style={{ display: 'flex', alignItems: 'center', lineHeight: 0, marginBottom:'0.5rem' }}>
            {/* <OpsAILogo height={30} opsColor="#ffffff" /> */}
            {window.innerWidth <500 ? <LogoIcon height={30} /> : <OpsAILogo height={30} opsColor={WHITISH}/> }
          </div>

          {/* Nav links */}
          <div className="hidden md:flex items-center gap-8 text-sm" style={{ color: 'rgba(255,255,255,0.65)' }}>
            <a href="#features"    className="transition-colors hover:text-white">Features</a>
            <a href="#how-it-works" className="transition-colors hover:text-white">How it Works</a>
            <Link to="/pricing"    className="transition-colors hover:text-white">Pricing</Link>
          </div>

          {/* Auth */}
          <div className="flex items-center gap-3">
            <Link to="/auth/login">
              <Button variant="ghost" size="sm" style={{ color: 'rgba(255,255,255,0.7)' }}
                className="hover:text-white hover:bg-white/5">
                Sign In
              </Button>
            </Link>
            <Link to="/auth/signup">
              <Button size="sm"
                style={{ background: TEAL, color: NAVY, fontWeight: 600, border: 'none' }}
                className="hover:opacity-90">
                Get Started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <section
        className="relative min-h-screen flex items-center pt-16 overflow-hidden"
        // style={{ background: WHITISH }}
        style={{ background: NAVY }}
      >
        {/* Animated glow orbs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="orb-1 absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full blur-[120px]"
            style={{ background: `${TEAL}18` }} />
          <div className="orb-2 absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full blur-[100px]"
            style={{ background: `${TEAL}10` }} />
          <div className="orb-3 absolute top-1/2 right-1/3 w-[300px] h-[300px] rounded-full blur-[80px]"
            style={{ background: `${TEAL}08` }} />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 py-24 lg:py-32 grid lg:grid-cols-2 gap-16 items-center">
          {/* Left — copy */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-8"
              style={{ background: `${TEAL}18`, border: `1px solid ${TEAL}33` }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: TEAL }} />
              <span className="text-xs font-medium" style={{ color: TEAL }}>Now in Public Beta</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold leading-[1.1] mb-6"
              style={{ color: WHITISH }}>
              Your Enterprise AI<br />Operating Layer
            </h1>

            <p className="text-lg max-w-lg mb-10 leading-relaxed"
              style={{ color: 'rgba(255,255,255,0.65)' }}>
              Connect any API or database. Auto-build RAG pipelines.<br />
              Enforce RACI governance. Execute safely.
            </p>

            <div className="flex flex-wrap gap-4">
              <Link to="/auth/signup">
                <Button size="lg" className="px-8 h-12 text-base font-semibold border-0 hover:opacity-90"
                  style={{
                    background: TEAL,
                    color: NAVY,
                    boxShadow: `0 0 40px ${TEAL}44`,
                  }}>
                  Start Free Trial <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </Link>
              <Link to="/auth/login">
                <button
                  className="inline-flex items-center justify-center px-8 h-12 text-base font-medium rounded-lg transition-colors hover:bg-white/10"
                  style={{
                    background: 'transparent',
                    border: '1.5px solid rgba(255,255,255,0.35)',
                    color: '#ffffff',
                    // color: NAVY,
                  }}
                >
                  See Demo
                </button>
              </Link>
            </div>
          </motion.div>

          {/* Right — dashboard mockup */}
          <motion.div
            initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="hidden lg:block"
          >
            <div className="relative">
              <div className="absolute -inset-4 rounded-2xl blur-2xl"
                style={{ background: `linear-gradient(135deg, ${TEAL}28, ${NAVY2}80)` }} />
              <div className="relative rounded-xl border backdrop-blur-sm p-1 shadow-2xl"
                style={{ borderColor: 'rgba(79,222,170,0.18)', background: 'rgba(255,255,255,0.04)' }}>
                <div className="rounded-lg p-4" style={{ background: NAVY2 }}>
                  {/* Window chrome */}
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-3 h-3 rounded-full bg-red-400/60" />
                    <div className="w-3 h-3 rounded-full bg-yellow-400/60" />
                    <div className="w-3 h-3 rounded-full rounded-full" style={{ background: `${TEAL}99` }} />
                    <div className="flex-1 mx-4 h-6 rounded bg-white/5" />
                  </div>

                  {/* Stat cards */}
                  <div className="grid grid-cols-4 gap-3 mb-4">
                    {['12 APIs', '48 Sessions', '3 Pending', '99.2%'].map((v, i) => (
                      <div key={i} className="rounded-lg p-3"
                        style={{
                          background: i === 2
                            ? `${TEAL}22`
                            : 'rgba(255,255,255,0.05)',
                          border: i === 2 ? `1px solid ${TEAL}44` : '1px solid rgba(255,255,255,0.06)',
                        }}>
                        <div className="text-[10px] mb-1" style={{ color: 'rgba(255,255,255,0.5)' }}>
                          {['Connections', 'Chat Sessions', 'Approvals', 'Success'][i]}
                        </div>
                        <div className="text-sm font-bold text-white">{v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Log rows */}
                  <div className="space-y-2">
                    {[
                      { label: 'POST /api/users',    tag: 'low',  tagStyle: { background: `${TEAL}22`, color: TEAL } },
                      { label: 'DELETE /api/orders', tag: 'high', tagStyle: { background: 'rgba(239,68,68,0.2)', color: '#f87171' } },
                      { label: 'Schema sync done',   tag: 'info', tagStyle: { background: `${TEAL}18`, color: TEAL } },
                    ].map((row, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md px-3 py-2"
                        style={{ background: 'rgba(255,255,255,0.03)' }}>
                        <span className="text-xs font-mono" style={{ color: 'rgba(255,255,255,0.55)' }}>{row.label}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={row.tagStyle}>{row.tag}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Social Proof ────────────────────────────────────────────────────── */}
      {/* <section style={{ background: NAVY2, borderTop: '1px solid rgba(79,222,170,0.08)' }} className="py-12">
        <div className="max-w-7xl mx-auto px-6">
          <p className="text-center text-sm mb-8" style={{ color: 'rgba(255,255,255,0.4)' }}>Trusted by teams at...</p>
          <div className="flex items-center justify-center gap-12 flex-wrap">
            {logos.map((name) => (
              <span key={name} className="text-lg font-bold tracking-wider uppercase"
                style={{ color: 'rgba(255,255,255,0.18)' }}>{name}</span>
            ))}
          </div>
        </div>
      </section> */}

      {/* ── Features ────────────────────────────────────────────────────────── */}
      <section id="features" className="py-24" style={{ background: '#F0F9F5' }}>
        <div className="max-w-7xl mx-auto px-6">
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-100px' }}
            className="text-center mb-16">
            <motion.p variants={fadeUp} custom={0}
              className="text-sm font-semibold uppercase tracking-wider mb-3"
              style={{ color: TEAL_DIM }}>
              Capabilities
            </motion.p>
            <motion.h2 variants={fadeUp} custom={1}
              className="text-3xl sm:text-4xl font-bold mb-4"
              style={{ color: NAVY }}>
              Everything your AI runtime needs
            </motion.h2>
            <motion.p variants={fadeUp} custom={2} className="max-w-2xl mx-auto" style={{ color: '#4b6280' }}>
              From API discovery to governance enforcement, OpsAI handles the full lifecycle
              of autonomous enterprise operations.
            </motion.p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <motion.div key={f.title}
                initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-50px' }}
                custom={i} variants={fadeUp}
                className="group rounded-xl border p-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-xl"
                style={{ background: '#ffffff', borderColor: '#ddeee8' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = `${TEAL}55`)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = '#ddeee8')}>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4 transition-colors"
                  style={{ background: `${TEAL}20` }}>
                  <f.icon className="w-5 h-5" style={{ color: NAVY }} />
                </div>
                <h3 className="text-base font-semibold mb-2" style={{ color: NAVY }}>{f.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: '#4b6280' }}>{f.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How It Works ────────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-24" style={{ background: '#e8f5ef' }}>
        <div className="max-w-7xl mx-auto px-6">
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-100px' }}
            className="text-center mb-16">
            <motion.p variants={fadeUp} custom={0}
              className="text-sm font-semibold uppercase tracking-wider mb-3"
              style={{ color: TEAL_DIM }}>
              How It Works
            </motion.p>
            <motion.h2 variants={fadeUp} custom={1}
              className="text-3xl sm:text-4xl font-bold mb-4"
              style={{ color: NAVY }}>
              Three steps to autonomous operations
            </motion.h2>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 relative">
            {steps.map((step, i) => (
              <motion.div key={step.num}
                initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-50px' }}
                custom={i} variants={fadeUp}
                className="relative text-center">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-6 relative z-10 shadow-lg"
                  style={{
                    background: TEAL,
                    boxShadow: `0 0 24px ${TEAL}55`,
                  }}>
                  <step.icon className="w-6 h-6" style={{ color: NAVY }} />
                </div>
                <span className="text-xs font-mono font-bold" style={{ color: TEAL_DIM }}>{step.num}</span>
                <h3 className="text-lg font-bold mt-2 mb-2" style={{ color: NAVY }}>{step.title}</h3>
                <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: '#4b6280' }}>{step.desc}</p>
                {i < steps.length - 1 && (
                  <ArrowRight className="hidden md:block absolute -right-6 top-8 w-5 h-5" style={{ color: `${TEAL_DIM}99` }} />
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────────────────────────── */}
      <section id="pricing" className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-6">
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-100px' }}
            className="text-center mb-16">
            <motion.p variants={fadeUp} custom={0}
              className="text-sm font-semibold uppercase tracking-wider mb-3"
              style={{ color: TEAL_DIM }}>
              Pricing
            </motion.p>
            <motion.h2 variants={fadeUp} custom={1}
              className="text-3xl sm:text-4xl font-bold mb-4"
              style={{ color: NAVY }}>
              Simple, transparent pricing
            </motion.h2>
            <motion.p variants={fadeUp} custom={2} style={{ color: '#4b6280' }}>
              Start free. Scale when you're ready.
            </motion.p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {pricing.map((plan, i) => (
              <motion.div key={plan.name}
                initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-50px' }}
                custom={i} variants={fadeUp}
                className="rounded-xl border p-8 flex flex-col relative"
                style={{
                  background: plan.highlighted ? '#ffffff' : '#ffffff',
                  borderColor: plan.highlighted ? TEAL : '#ddeee8',
                  boxShadow: plan.highlighted ? `0 0 40px ${TEAL}22` : undefined,
                }}>
                {plan.highlighted && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span className="text-xs font-semibold px-4 py-1 rounded-full"
                      style={{ background: TEAL, color: NAVY }}>
                      Most Popular
                    </span>
                  </div>
                )}
                <h3 className="text-lg font-bold" style={{ color: NAVY }}>{plan.name}</h3>
                <p className="text-sm mt-1 mb-4" style={{ color: '#4b6280' }}>{plan.desc}</p>
                <div className="flex items-baseline gap-1 mb-6">
                  <span className="text-4xl font-extrabold" style={{ color: NAVY }}>{plan.price}</span>
                  {plan.period && <span className="text-sm" style={{ color: '#4b6280' }}>{plan.period}</span>}
                </div>
                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2.5 text-sm" style={{ color: '#334e68' }}>
                      <Check className="w-4 h-4 shrink-0" style={{ color: TEAL_DIM }} />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link to="/auth/signup">
                  <Button className="w-full font-semibold border-0 hover:opacity-90"
                    style={plan.highlighted
                      ? { background: TEAL, color: NAVY }
                      : { background: 'transparent', color: NAVY, border: `1.5px solid ${NAVY}33` }}>
                    {plan.cta}
                  </Button>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────────── */}
      <section className="py-24 relative overflow-hidden" style={{ background: NAVY }}>
        <div className="absolute inset-0 pointer-events-none">
          <div className="orb-2 absolute top-0 left-1/3 w-[400px] h-[400px] rounded-full blur-[120px]"
            style={{ background: `${TEAL}15` }} />
        </div>
        <motion.div
          initial="hidden" whileInView="visible" viewport={{ once: true }}
          className="relative max-w-3xl mx-auto px-6 text-center">
          <motion.h2 variants={fadeUp} custom={0}
            className="text-3xl sm:text-4xl font-bold mb-4" style={{ color: '#ffffff' }}>
            Ready to automate your enterprise?
          </motion.h2>
          <motion.p variants={fadeUp} custom={1}
            className="mb-8 text-lg" style={{ color: 'rgba(255,255,255,0.6)' }}>
            Join hundreds of teams using OpsAI to connect, govern, and execute with AI.
          </motion.p>
          <motion.div variants={fadeUp} custom={2}>
            <Link to="/auth/signup">
              <Button size="lg" className="border-0 px-10 h-12 text-base font-semibold hover:opacity-90"
                style={{
                  background: TEAL,
                  color: NAVY,
                  boxShadow: `0 0 50px ${TEAL}44`,
                }}>
                Start Free Trial <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </motion.div>
        </motion.div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer style={{ background: NAVY2, borderTop: '1px solid rgba(79,222,170,0.1)' }} className="py-12">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            {/* Brand */}
            <div>
              <div className="mb-4">
                <OpsAILogo height={28} opsColor="#ffffff" />
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Autonomous Enterprise AI Runtime for modern teams.
              </p>
            </div>

            {/* Product */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'rgba(255,255,255,0.7)' }}>Product</h4>
              <ul className="space-y-2 text-sm" style={{ color: 'rgba(255,255,255,0.45)' }}>
                <li><a href="#features"               className="hover:text-white transition-colors">Features</a></li>
                <li><Link to="/pricing"               className="hover:text-white transition-colors">Pricing</Link></li>
                <li><Link to="/dashboard/audit"       className="hover:text-white transition-colors">Changelog</Link></li>
              </ul>
            </div>

            {/* Company */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'rgba(255,255,255,0.7)' }}>Company</h4>
              <ul className="space-y-2 text-sm" style={{ color: 'rgba(255,255,255,0.45)' }}>
                <li><Link to="/pricing"              className="hover:text-white transition-colors">About</Link></li>
                <li><Link to="/dashboard/insights"   className="hover:text-white transition-colors">Blog</Link></li>
                <li><Link to="/auth/signup"          className="hover:text-white transition-colors">Careers</Link></li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'rgba(255,255,255,0.7)' }}>Legal</h4>
              <ul className="space-y-2 text-sm" style={{ color: 'rgba(255,255,255,0.45)' }}>
                <li><Link to="/legal/privacy"  className="hover:text-white transition-colors">Privacy</Link></li>
                <li><Link to="/legal/terms"    className="hover:text-white transition-colors">Terms</Link></li>
                <li><Link to="/legal/security" className="hover:text-white transition-colors">Security</Link></li>
              </ul>
            </div>
          </div>

          <div className="pt-8 text-center" style={{ borderTop: '1px solid rgba(79,222,170,0.1)' }}>
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>© 2026 OpsAI. All rights reserved.</p>
          </div>
        </div>
      </footer>

    </div>
  );
}
