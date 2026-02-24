import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Bot, Zap, Shield, Brain, Eye, Lock, RefreshCw, ArrowRight, Check, Plug, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

const features = [
  { icon: Zap, title: 'Auto-Discovery', desc: 'Connect any API via URL. Zero manual mapping.' },
  { icon: Shield, title: 'RACI Governance', desc: 'Enforce org hierarchy. Not everyone can do everything.' },
  { icon: Brain, title: 'Smart Agents', desc: 'Domain AI agents built automatically from your schema.' },
  { icon: Eye, title: 'Predictive AI', desc: 'Surface insights before problems happen.' },
  { icon: Lock, title: 'Critical Protection', desc: 'Block destructive actions. Multi-approval workflows.' },
  { icon: RefreshCw, title: 'Live Sync', desc: 'Real-time data sync. Always fresh RAG responses.' },
];

const steps = [
  { num: '01', icon: Plug, title: 'Connect', desc: 'Paste your API URL or DB connection.' },
  { num: '02', icon: Search, title: 'Discover', desc: 'AI maps your entire data structure automatically.' },
  { num: '03', icon: ShieldCheck, title: 'Govern & Execute', desc: 'Chat, query, act - all within your org\'s rules.' },
];

const pricing = [
  { name: 'Starter', price: '$49', period: '/mo', desc: 'For small teams getting started', features: ['5 API connections', '1,000 AI calls/mo', '3 team members', 'Email support'], cta: 'Start Free', highlighted: false },
  { name: 'Pro', price: '$299', period: '/mo', desc: 'For growing organizations', features: ['Unlimited connections', '25,000 AI calls/mo', '25 team members', 'RACI governance', 'Priority support'], cta: 'Start Free Trial', highlighted: true },
  { name: 'Enterprise', price: 'Custom', period: '', desc: 'For large-scale deployments', features: ['Everything in Pro', 'Unlimited AI calls', 'SSO & SAML', 'Dedicated support', 'Custom SLA'], cta: 'Contact Sales', highlighted: false },
];

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1, duration: 0.5, ease: [0, 0, 0.2, 1] as const } }),
};

const logos = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Stark Ind.'];

export default function LandingPage() {
  return (
    <div className="overflow-hidden">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-[#1A1A2E]/85 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg gradient-cta flex items-center justify-center">
              <Bot className="w-4 h-4 text-accent-foreground" />
            </div>
            <span className="text-lg font-bold text-hero tracking-tight">AEAR</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-hero-muted">
            <a href="#features" className="hover:text-hero transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-hero transition-colors">How it Works</a>
            <Link to="/pricing" className="hover:text-hero transition-colors">Pricing</Link>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/auth/login">
              <Button variant="ghost" size="sm" className="text-hero-muted hover:text-hero hover:bg-white/5">
                Sign In
              </Button>
            </Link>
            <Link to="/auth/signup">
              <Button size="sm" className="gradient-cta text-accent-foreground hover:opacity-90 border-0">
                Get Started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative min-h-screen flex items-center pt-16 overflow-hidden bg-[#1A1A2E]">
        {/* Orbs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="orb-1 absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-accent/10 blur-[120px]" />
          <div className="orb-2 absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-secondary/10 blur-[100px]" />
          <div className="orb-3 absolute top-1/2 right-1/3 w-[300px] h-[300px] rounded-full bg-accent/5 blur-[80px]" />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 py-24 lg:py-32 grid lg:grid-cols-2 gap-16 items-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/20 mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="text-xs font-medium text-accent">Now in Public Beta</span>
            </div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-hero leading-[1.1] mb-6">Your Enterprise AI Operating Layer</h1>
            <p className="text-lg text-hero-muted max-w-lg mb-10 leading-relaxed">
              Connect any API or database. Auto-build RAG pipelines. Enforce RACI governance. Execute safely.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link to="/auth/signup">
                <Button size="lg" className="gradient-cta text-accent-foreground hover:opacity-90 border-0 px-8 h-12 text-base font-semibold shadow-glow-lg">
                  Start Free Trial
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </Link>
              <Link to="/auth/login">
                <Button size="lg" variant="outline" className="border-white/15 text-hero hover:bg-white/5 px-8 h-12 text-base">
                  See Demo
                </Button>
              </Link>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="hidden lg:block"
          >
            {/* Dashboard mockup */}
            <div className="relative">
              <div className="absolute -inset-4 rounded-2xl bg-gradient-to-br from-accent/20 to-secondary/10 blur-2xl" />
              <div className="relative rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-1 shadow-2xl">
                <div className="rounded-lg bg-[hsl(240,17%,11%)] p-4">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-3 h-3 rounded-full bg-destructive/60" />
                    <div className="w-3 h-3 rounded-full bg-[hsl(45,93%,58%)]/60" />
                    <div className="w-3 h-3 rounded-full bg-secondary/60" />
                    <div className="flex-1 mx-4 h-6 rounded bg-white/5" />
                  </div>
                  <div className="grid grid-cols-4 gap-3 mb-4">
                    {['12 APIs', '48 Sessions', '3 Pending', '99.2%'].map((v, i) => (
                      <div key={i} className="rounded-lg bg-white/5 p-3">
                        <div className="text-[10px] text-hero-muted mb-1">
                          {['Connections', 'Chat Sessions', 'Approvals', 'Success'][i]}
                        </div>
                        <div className="text-sm font-bold text-hero">{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2">
                    {[
                      { label: 'POST /api/users', tag: 'low', color: 'bg-secondary/20 text-secondary' },
                      { label: 'DELETE /api/orders', tag: 'high', color: 'bg-destructive/20 text-destructive' },
                      { label: 'Schema sync done', tag: 'info', color: 'bg-accent/20 text-accent' },
                    ].map((row, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md bg-white/[0.03] px-3 py-2">
                        <span className="text-xs font-mono text-hero-muted">{row.label}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${row.color}`}>{row.tag}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="bg-[#1A1A2E] border-t border-white/5 py-12">
        <div className="max-w-7xl mx-auto px-6">
          <p className="text-center text-sm text-hero-muted mb-8">Trusted by teams at...</p>
          <div className="flex items-center justify-center gap-12 flex-wrap">
            {logos.map((name) => (
              <span key={name} className="text-hero-muted/40 text-lg font-bold tracking-wider uppercase">{name}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 bg-[#F8FAFC] text-slate-900">
        <div className="max-w-7xl mx-auto px-6">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            className="text-center mb-16"
          >
            <motion.p variants={fadeUp} custom={0} className="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
              Capabilities
            </motion.p>
            <motion.h2 variants={fadeUp} custom={1} className="text-3xl sm:text-4xl font-bold mb-4">
              Everything your AI runtime needs
            </motion.h2>
            <motion.p variants={fadeUp} custom={2} className="text-slate-600 max-w-2xl mx-auto">
              From API discovery to governance enforcement, AEAR handles the full lifecycle of autonomous enterprise operations.
            </motion.p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <motion.div
                key={f.title}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-50px" }}
                custom={i}
                variants={fadeUp}
                className="group rounded-xl border border-slate-200 bg-white p-6 shadow-sm hover:-translate-y-1 hover:shadow-xl hover:border-accent/30 transition-all duration-300"
              >
                <div className="w-11 h-11 rounded-xl bg-accent/10 flex items-center justify-center mb-4 group-hover:bg-accent/20 transition-colors">
                  <f.icon className="w-5 h-5 text-accent" />
                </div>
                <h3 className="text-base font-semibold mb-2">{f.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{f.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-24 bg-muted/50">
        <div className="max-w-7xl mx-auto px-6">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            className="text-center mb-16"
          >
            <motion.p variants={fadeUp} custom={0} className="text-sm font-semibold text-secondary uppercase tracking-wider mb-3">
              How It Works
            </motion.p>
            <motion.h2 variants={fadeUp} custom={1} className="text-3xl sm:text-4xl font-bold mb-4">
              Three steps to autonomous operations
            </motion.h2>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 relative">
            {steps.map((step, i) => (
              <motion.div
                key={step.num}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-50px" }}
                custom={i}
                variants={fadeUp}
                className="relative text-center"
              >
                <div className="w-14 h-14 rounded-2xl gradient-cta flex items-center justify-center mx-auto mb-6 shadow-glow relative z-10">
                  <step.icon className="w-6 h-6 text-accent-foreground" />
                </div>
                <span className="text-xs font-mono text-accent font-bold">{step.num}</span>
                <h3 className="text-lg font-bold mt-2 mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">{step.desc}</p>
                {i < steps.length - 1 && (
                  <ArrowRight className="hidden md:block absolute -right-6 top-8 w-5 h-5 text-accent/70" />
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 bg-background">
        <div className="max-w-7xl mx-auto px-6">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            className="text-center mb-16"
          >
            <motion.p variants={fadeUp} custom={0} className="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
              Pricing
            </motion.p>
            <motion.h2 variants={fadeUp} custom={1} className="text-3xl sm:text-4xl font-bold mb-4">
              Simple, transparent pricing
            </motion.h2>
            <motion.p variants={fadeUp} custom={2} className="text-muted-foreground">
              Start free. Scale when you're ready.
            </motion.p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {pricing.map((plan, i) => (
              <motion.div
                key={plan.name}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-50px" }}
                custom={i}
                variants={fadeUp}
                className={`rounded-xl border p-8 flex flex-col ${
                  plan.highlighted
                    ? 'border-accent bg-card shadow-glow-lg relative'
                    : 'border-border bg-card'
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="gradient-cta text-accent-foreground text-xs font-semibold px-4 py-1 rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}
                <h3 className="text-lg font-bold">{plan.name}</h3>
                <p className="text-sm text-muted-foreground mt-1 mb-4">{plan.desc}</p>
                <div className="flex items-baseline gap-1 mb-6">
                  <span className="text-4xl font-extrabold">{plan.price}</span>
                  {plan.period && <span className="text-muted-foreground text-sm">{plan.period}</span>}
                </div>
                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2.5 text-sm">
                      <Check className="w-4 h-4 text-secondary shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link to="/auth/signup">
                  <Button
                    className={`w-full ${plan.highlighted ? 'gradient-cta text-accent-foreground hover:opacity-90 border-0' : ''}`}
                    variant={plan.highlighted ? 'default' : 'outline'}
                  >
                    {plan.cta}
                  </Button>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 bg-[#1A1A2E] relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="orb-2 absolute top-0 left-1/3 w-[400px] h-[400px] rounded-full bg-accent/10 blur-[120px]" />
        </div>
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="relative max-w-3xl mx-auto px-6 text-center"
        >
          <motion.h2 variants={fadeUp} custom={0} className="text-3xl sm:text-4xl font-bold text-hero mb-4">
            Ready to automate your enterprise?
          </motion.h2>
          <motion.p variants={fadeUp} custom={1} className="text-hero-muted mb-8 text-lg">
            Join hundreds of teams using AEAR to connect, govern, and execute with AI.
          </motion.p>
          <motion.div variants={fadeUp} custom={2}>
            <Link to="/auth/signup">
              <Button size="lg" className="gradient-cta text-accent-foreground hover:opacity-90 border-0 px-10 h-12 text-base font-semibold shadow-glow-lg">
                Start Free Trial
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </motion.div>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="bg-[#1A1A2E] border-t border-white/5 py-12">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-md gradient-cta flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-accent-foreground" />
                </div>
                <span className="text-sm font-bold text-hero">AEAR</span>
              </div>
              <p className="text-xs text-hero-muted leading-relaxed">
                Autonomous Enterprise AI Runtime for modern teams.
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-hero uppercase tracking-wider mb-3">Product</h4>
              <ul className="space-y-2 text-sm text-hero-muted">
                <li><a href="#features" className="hover:text-hero transition-colors">Features</a></li>
                <li><Link to="/pricing" className="hover:text-hero transition-colors">Pricing</Link></li>
                <li><Link to="/dashboard/audit" className="hover:text-hero transition-colors">Changelog</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-hero uppercase tracking-wider mb-3">Company</h4>
              <ul className="space-y-2 text-sm text-hero-muted">
                <li><Link to="/pricing" className="hover:text-hero transition-colors">About</Link></li>
                <li><Link to="/dashboard/insights" className="hover:text-hero transition-colors">Blog</Link></li>
                <li><Link to="/auth/signup" className="hover:text-hero transition-colors">Careers</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-hero uppercase tracking-wider mb-3">Legal</h4>
              <ul className="space-y-2 text-sm text-hero-muted">
                <li><Link to="/legal/privacy" className="hover:text-hero transition-colors">Privacy</Link></li>
                <li><Link to="/legal/terms" className="hover:text-hero transition-colors">Terms</Link></li>
                <li><Link to="/legal/security" className="hover:text-hero transition-colors">Security</Link></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-white/5 pt-8 text-center">
            <p className="text-xs text-hero-muted">© 2026 AEAR. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
