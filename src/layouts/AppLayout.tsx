import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  Bot,
  ChevronDown,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Plug,
  Store,
  ScrollText,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Users,
  UserRound,
  Workflow,
  Wrench,
  BookOpenText,
  CheckSquare,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { ensureUserWorkspace } from '@/lib/auth-provisioning';
import { supabase } from '@/integrations/supabase/client';

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: string;
  adminOnly?: boolean;
};

const NAV_SECTIONS: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Workspace',
    items: [
      { to: '/dashboard', label: 'Home', icon: LayoutDashboard, end: true },
      { to: '/dashboard/chat', label: 'AI Chat', icon: MessageSquare },
      { to: '/dashboard/insights', label: 'Insights', icon: BarChart3 },
    ],
  },
  {
    section: 'Data',
    items: [
      { to: '/dashboard/connections', label: 'Connections', icon: Plug },
      { to: '/dashboard/knowledge', label: 'Knowledge Base', icon: BookOpenText },
      { to: '/dashboard/agents', label: 'Agents', icon: Workflow },
      { to: '/dashboard/tools', label: 'Tool Registry', icon: Wrench },
      { to: '/dashboard/marketplace', label: 'Marketplace', icon: Store },
    ],
  },
  {
    section: 'Governance',
    items: [
      { to: '/dashboard/raci', label: 'RACI Matrix', icon: Shield },
      { to: '/dashboard/approvals', label: 'Approvals', icon: CheckSquare },
      { to: '/dashboard/audit', label: 'Audit Log', icon: ScrollText },
      { to: '/dashboard/guardrails', label: 'Guardrails', icon: ShieldCheck },
    ],
  },
  {
    section: 'Settings',
    items: [
      { to: '/dashboard/admin', label: 'Admin Console', icon: ShieldCheck, adminOnly: true },
      { to: '/dashboard/team', label: 'Team', icon: Users },
      { to: '/dashboard/api-keys', label: 'API Keys', icon: KeyRound },
      { to: '/dashboard/billing', label: 'Usage & Billing', icon: CreditCard },
      { to: '/dashboard/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);
const TITLE_BY_ROUTE = ALL_NAV_ITEMS.reduce<Record<string, string>>((acc, item) => {
  acc[item.to] = item.label;
  return acc;
}, {});

function userInitials(userName: string, email: string | null) {
  const normalized = userName.trim();
  if (!normalized) return email?.[0]?.toUpperCase() ?? 'U';
  const pieces = normalized.split(/\s+/).slice(0, 2);
  return pieces.map((piece) => piece[0]?.toUpperCase() ?? '').join('') || 'U';
}

type SidebarProps = {
  workspaceName: string;
  userName: string;
  userEmail: string | null;
  pendingApprovals: number;
  canAccessAdmin: boolean;
  onNavigate?: () => void;
  onSignOut: () => void;
};

function SidebarContent({ workspaceName, userName, userEmail, pendingApprovals, canAccessAdmin, onNavigate, onSignOut }: SidebarProps) {
  const navItemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const visibleSections = useMemo(
    () =>
      NAV_SECTIONS
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => !item.adminOnly || canAccessAdmin),
        }))
        .filter((group) => group.items.length > 0),
    [canAccessAdmin],
  );

  const visibleItems = useMemo(
    () => visibleSections.flatMap((group) => group.items),
    [visibleSections],
  );

  useEffect(() => {
    navItemRefs.current = Array(visibleItems.length).fill(null);
  }, [visibleItems.length]);

  const itemIndexByPath = useMemo(
    () => new Map(visibleItems.map((item, index) => [item.to, index])),
    [visibleItems],
  );

  const handleArrowNavigation = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();

    const focusedElement = document.activeElement as HTMLAnchorElement | null;
    const currentIndex = navItemRefs.current.findIndex((element) => element === focusedElement);
    if (currentIndex < 0) {
      navItemRefs.current[0]?.focus();
      return;
    }

    const step = event.key === 'ArrowDown' ? 1 : -1;
    if (navItemRefs.current.length === 0) return;
    const nextIndex = (currentIndex + step + navItemRefs.current.length) % navItemRefs.current.length;
    navItemRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="flex h-full flex-col bg-[#1A1A2E] text-slate-200">
      <div className="border-b border-white/10 p-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left transition-colors hover:bg-white/10"
            >
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-violet-700">
                <Bot className="h-4 w-4 text-white" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">OpsAI</span>
                <span className="block truncate text-xs text-slate-400">{workspaceName}</span>
              </span>
              <ChevronDown className="h-4 w-4 text-slate-400" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>Primary Workspace</DropdownMenuItem>
            <DropdownMenuItem>Finance Sandbox</DropdownMenuItem>
            <DropdownMenuItem>Product Lab</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4" onKeyDown={handleArrowNavigation}>
        {visibleSections.map((group) => (
          <section key={group.section} aria-label={group.section}>
            <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              {group.section}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const itemIndex = itemIndexByPath.get(item.to) ?? 0;

                return (
                  <NavLink
                    key={item.to}
                    end={item.end}
                    to={item.to}
                    ref={(node) => {
                      navItemRefs.current[itemIndex] = node;
                    }}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400',
                        isActive
                          ? 'border-violet-400/40 bg-violet-500/20 text-white'
                          : 'border-transparent text-slate-300 hover:bg-white/10 hover:text-white',
                      )
                    }
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {(item.badge || (item.to === '/dashboard/approvals' && pendingApprovals > 0)) && (
                      <Badge className="border-0 bg-violet-500/80 px-2 py-0 text-[10px] font-semibold text-white">
                        {item.badge ?? String(pendingApprovals)}
                      </Badge>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </section>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <div className="mb-2 flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-violet-600 text-xs font-semibold text-white">
              {userInitials(userName, userEmail)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{userName}</p>
            <p className="truncate text-xs text-slate-400">{userEmail ?? 'No email found'}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={onSignOut}
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </div>
  );
}

export default function AppLayout() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [canAccessAdmin, setCanAccessAdmin] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const pageTitle = useMemo(() => {
    if (location.pathname.startsWith('/platform-admin')) return 'Platform Admin';
    if (TITLE_BY_ROUTE[location.pathname]) return TITLE_BY_ROUTE[location.pathname];
    const matchingParent = ALL_NAV_ITEMS
      .filter((item) => item.to !== '/dashboard')
      .find((item) => location.pathname.startsWith(`${item.to}/`));
    return matchingParent?.label ?? 'Dashboard';
  }, [location.pathname]);

  const shortcutLabel =
    typeof window !== 'undefined' && /Mac|iPhone|iPad/i.test(window.navigator.platform)
      ? 'Cmd+K'
      : 'Ctrl+K';

  const workspaceName =
    typeof user?.user_metadata?.company_name === 'string' && user.user_metadata.company_name.trim()
      ? user.user_metadata.company_name.trim()
      : 'Workspace';
  const userName =
    typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()
      ? user.user_metadata.full_name.trim()
      : 'OpsAI User';

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (location.pathname !== '/dashboard/chat') {
          navigate('/dashboard/chat');
        }
        window.setTimeout(() => {
          window.dispatchEvent(new Event('opsai:focus-chat-input'));
        }, 40);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [location.pathname, navigate]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!user) return;

    let active = true;
    let intervalId: number | null = null;

    const loadCounts = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (!active) return;
        const role = (workspace.role || '').toLowerCase();
        setCanAccessAdmin(role === 'admin' || role === 'owner');
        const { data, error } = await supabase.rpc('get_nav_counts');
        if (error || !active) return;

        const row = (data as Array<{ pending_approvals: number; unread_notifications: number }> | null)?.[0];
        setPendingApprovals(row?.pending_approvals ?? 0);
        setUnreadNotifications(row?.unread_notifications ?? 0);
      } catch {
        // Transient error — keep the current canAccessAdmin value; don't reset to false
        // so the sidebar doesn't blink between re-runs.
      }
    };

    void loadCounts();
    intervalId = window.setInterval(() => {
      void loadCounts();
    }, 30000);

    return () => {
      active = false;
      if (intervalId) window.clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]); // re-run only when the authenticated user changes, not on same-user reference changes

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <a
        href="#dashboard-main-content"
        className="sr-only z-50 rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 hidden w-[240px] border-r border-white/10 lg:block">
        <SidebarContent
          workspaceName={workspaceName}
          userName={userName}
          userEmail={user?.email ?? null}
          pendingApprovals={pendingApprovals}
          canAccessAdmin={canAccessAdmin}
          onSignOut={handleSignOut}
        />
      </aside>

      <div className="flex min-h-screen flex-col lg:ml-[240px]">
        <header className="sticky top-0 z-30 h-16 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex h-full items-center justify-between gap-3 px-4 md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold text-slate-900">{pageTitle}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 md:gap-3">
              <div className="relative hidden sm:block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  ref={searchInputRef}
                  placeholder="Jump to AI Chat"
                  className="h-10 w-[250px] border-slate-200 bg-slate-50 pl-9 pr-16"
                  onFocus={() => {
                    if (location.pathname !== '/dashboard/chat') {
                      navigate('/dashboard/chat');
                    }
                    window.setTimeout(() => {
                      window.dispatchEvent(new Event('opsai:focus-chat-input'));
                    }, 40);
                  }}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                  {shortcutLabel}
                </span>
              </div>

              <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
                <Bell className="h-5 w-5 text-slate-600" />
                {unreadNotifications > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-violet-600 px-1 text-[10px] font-semibold text-white">
                    {unreadNotifications}
                  </span>
                )}
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white p-1 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-slate-200 text-xs font-semibold text-slate-700">
                        {userInitials(userName, user?.email ?? null)}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={() => navigate('/dashboard/settings')}>
                    <UserRound className="h-4 w-4" />
                    Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate('/dashboard/settings')}>
                    <Settings className="h-4 w-4" />
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleSignOut}>
                    <LogOut className="h-4 w-4" />
                    Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <main id="dashboard-main-content" className="flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6">
          <Outlet />
        </main>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[270px] border-r border-white/10 bg-[#1A1A2E] p-0 text-slate-200">
          <div className="flex h-full flex-col">
            <SidebarContent
              workspaceName={workspaceName}
              userName={userName}
              userEmail={user?.email ?? null}
              pendingApprovals={pendingApprovals}
              canAccessAdmin={canAccessAdmin}
              onNavigate={() => setMobileNavOpen(false)}
              onSignOut={handleSignOut}
            />
            <div className="border-t border-white/10 px-4 py-3 text-[11px] uppercase tracking-[0.12em] text-slate-400">
              Swipe to close
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
