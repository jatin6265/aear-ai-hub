import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAppStore } from '@/stores/appStore';
import {
  LayoutDashboard,
  MessageSquare,
  Plug,
  Shield,
  ScrollText,
  CheckSquare,
  BarChart3,
  Settings,
  LogOut,
  Menu,
  X,
  Bot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chat', icon: MessageSquare, label: 'AI Chat' },
  { to: '/connections', icon: Plug, label: 'API Connections' },
  { to: '/raci', icon: Shield, label: 'RACI Matrix' },
  { to: '/audit', icon: ScrollText, label: 'Audit Logs' },
  { to: '/approvals', icon: CheckSquare, label: 'Approvals' },
  { to: '/usage', icon: BarChart3, label: 'Usage' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function AppLayout() {
  const { user, signOut } = useAuth();
  const { sidebarOpen, toggleSidebar } = useAppStore();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? 'w-64' : 'w-0 -ml-64'
        } transition-all duration-300 ease-in-out bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border md:relative fixed inset-y-0 left-0 z-40`}
      >
        <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
          <div className="w-9 h-9 rounded-lg gradient-accent flex items-center justify-center">
            <Bot className="w-5 h-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-sidebar-primary-foreground">AEAR</h1>
            <p className="text-[11px] text-sidebar-foreground/60 leading-none">Enterprise AI Runtime</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-primary-foreground'
                    : 'text-sidebar-foreground/70 hover:text-sidebar-primary-foreground hover:bg-sidebar-accent/50'
                }`
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-sidebar-border">
          <div className="flex items-center gap-3 px-3 py-2 mb-2">
            <div className="w-8 h-8 rounded-full gradient-accent flex items-center justify-center text-xs font-bold text-accent-foreground">
              {user?.email?.[0]?.toUpperCase() ?? 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-primary-foreground truncate">
                {user?.email ?? 'User'}
              </p>
              <p className="text-[10px] text-sidebar-foreground/50">Member</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-3 py-2 w-full rounded-lg text-sm text-sidebar-foreground/60 hover:text-sidebar-primary-foreground hover:bg-sidebar-accent/50 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 border-b border-border flex items-center px-4 gap-4 bg-card shrink-0">
          <Button variant="ghost" size="icon" onClick={toggleSidebar} className="shrink-0">
            {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </Button>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary/10 text-secondary text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse_dot" />
              System Online
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
