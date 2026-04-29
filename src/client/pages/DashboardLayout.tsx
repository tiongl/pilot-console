import { useEffect, useState, useCallback } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router';
import { useAuth } from '../lib/auth-context';
import { useTheme, THEMES, type ThemeId } from '../lib/theme-context';
import { Button } from '../../../components/ui/button';
import { Plus, Shield, LogOut, FolderOpen, Pin, Palette } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  repoPath: string;
  pinned?: number;
}

function statusPriority(status: SessionStatus): number {
  switch (status) {
    case 'busy': return 2;
    case 'idle': return 1;
    case 'exited': return 0;
  }
}

type SessionStatus = 'idle' | 'busy' | 'exited';

interface ProjectSessionInfo {
  status: SessionStatus;
  exitCode: number | null;
}

function StatusDot({ info }: { info: ProjectSessionInfo | undefined }) {
  if (!info) return null;

  if (info.status === 'busy') {
    return (
      <span
        className="h-2 w-2 shrink-0 rounded-full bg-yellow-400 animate-pulse-dot"
        title="Session active — working"
      />
    );
  }

  if (info.status === 'idle') {
    return (
      <span
        className="h-2 w-2 shrink-0 rounded-full bg-green-500"
        title="Session active — idle"
      />
    );
  }

  // exited
  if (info.exitCode !== null && info.exitCode !== 0) {
    return (
      <span
        className="h-2 w-2 shrink-0 rounded-full bg-red-500"
        title={`Session exited (code ${info.exitCode})`}
      />
    );
  }

  // exited cleanly — no indicator
  return null;
}

function ProjectNav({ projects }: { projects: Project[] }) {
  const location = useLocation();
  const [projectStatuses, setProjectStatuses] = useState<Map<string, ProjectSessionInfo>>(new Map());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(
    new Set(projects.filter(p => p.pinned).map(p => p.id))
  );

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/sessions/active');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            const statuses = new Map<string, ProjectSessionInfo>();
            for (const s of data.sessions || []) {
              // If multiple sessions for same project, prefer busy > idle > exited
              const existing = statuses.get(s.projectId);
              if (!existing || statusPriority(s.status) > statusPriority(existing.status)) {
                statuses.set(s.projectId, { status: s.status, exitCode: s.exitCode });
              }
            }
            setProjectStatuses(statuses);
          }
        }
      } catch {}
    }
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const togglePin = useCallback(async (e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const nowPinned = !pinnedIds.has(projectId);
    setPinnedIds(prev => {
      const next = new Set(prev);
      nowPinned ? next.add(projectId) : next.delete(projectId);
      return next;
    });
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: nowPinned }),
      });
    } catch {}
  }, [pinnedIds]);

  if (projects.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground text-center">
        No projects yet.{' '}
        <Link to="/projects/new" className="underline">Create one</Link>
      </p>
    );
  }

  const sorted = [...projects].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id) ? 1 : 0;
    const bPinned = pinnedIds.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sorted.map((project) => {
        const isActive = location.pathname.startsWith(`/projects/${project.id}`);
        return (
          <Link
            key={project.id}
            to={`/projects/${project.id}/chat`}
            className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="truncate flex-1">{project.name}</span>
            <button
              onClick={(e) => togglePin(e, project.id)}
              className={`h-4 w-4 shrink-0 transition-opacity ${
                pinnedIds.has(project.id)
                  ? 'text-primary opacity-100'
                  : 'text-muted-foreground opacity-0 group-hover:opacity-100'
              }`}
              title={pinnedIds.has(project.id) ? 'Unpin' : 'Pin to top'}
            >
              <Pin className="h-3.5 w-3.5" />
            </button>
            <StatusDot info={projectStatuses.get(project.id)} />
          </Link>
        );
      })}
    </>
  );
}

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [daemonConnected, setDaemonConnected] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => setProjects(data.projects || []))
      .catch(() => {});
  }, [location.pathname]);

  // Poll daemon status
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch('/api/daemon/status');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setDaemonConnected(data.connected);
        }
      } catch {
        if (!cancelled) setDaemonConnected(false);
      }
    }
    check();
    const interval = setInterval(check, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-background">
      <aside className="flex w-60 flex-col border-r bg-muted/40 px-3 py-4">
        <div className="mb-4 px-3">
          <h1 className="text-lg font-bold">GC Clippy</h1>
          <p className="text-xs text-muted-foreground truncate">{user?.displayName ?? user?.email}</p>
        </div>

        <div className="flex items-center justify-between px-3 mb-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Projects</span>
          <Link to="/projects/new" className="text-muted-foreground hover:text-foreground transition-colors">
            <Plus className="h-4 w-4" />
          </Link>
        </div>

        <nav className="flex flex-col gap-0.5 flex-1 overflow-y-auto">
          <ProjectNav projects={projects} />
        </nav>

        <div className="flex flex-col gap-1 border-t pt-3 mt-2">
          {/* Theme selector */}
          <div className="flex items-center gap-2 px-3 py-1.5">
            <Palette className="h-4 w-4 text-muted-foreground shrink-0" />
            <select
              value={theme}
              onChange={e => setTheme(e.target.value as ThemeId)}
              className="flex-1 text-sm bg-transparent border border-border rounded px-2 py-1 text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {THEMES.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          {user?.role === 'admin' && (
            <Link
              to="/admin"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Shield className="h-4 w-4" />
              Admin
            </Link>
          )}
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={handleLogout} className="flex-1 justify-start gap-3 px-3">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
            <Link
              to="/daemon"
              className="shrink-0 p-2 rounded-md hover:bg-accent transition-colors"
              title={daemonConnected === true ? 'Daemon connected' : daemonConnected === false ? 'Daemon disconnected' : 'Checking daemon...'}
            >
              <span
                className={`block h-2.5 w-2.5 rounded-full ${
                  daemonConnected === true ? 'bg-green-500' :
                  daemonConnected === false ? 'bg-red-500 animate-pulse' :
                  'bg-muted-foreground'
                }`}
              />
            </Link>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
