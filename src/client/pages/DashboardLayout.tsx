import { useEffect, useState, useCallback } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router';
import { useAuth } from '../lib/auth-context';
import { useTheme, THEMES, type ThemeId } from '../lib/theme-context';
import { Button } from '../../../components/ui/button';
import { Plus, Shield, LogOut, FolderOpen, Pin, Palette, Settings, ChevronRight, ChevronDown, GitBranch, Trash2 } from 'lucide-react';
import { SkillCatalog, InstalledSkillsPanel } from '../pages/ProjectSkillsPage';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { ClippyLogo } from '../components/ClippyLogo';

interface Project {
  id: string;
  name: string;
  repoPath: string;
  pinned?: number;
}

interface Worktree {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [worktreeMap, setWorktreeMap] = useState<Record<string, Worktree[]>>({});
  const [showAddDialog, setShowAddDialog] = useState<string | null>(null);
  const [wtName, setWtName] = useState('');
  const [wtBranch, setWtBranch] = useState('');
  const [wtCreateNew, setWtCreateNew] = useState(false);
  const [wtError, setWtError] = useState('');
  const [wtSaving, setWtSaving] = useState(false);

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

  const fetchWorktrees = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/worktrees`);
      if (res.ok) {
        const data = await res.json();
        setWorktreeMap(prev => ({ ...prev, [projectId]: data.worktrees || [] }));
      }
    } catch {}
  }, []);

  const toggleExpanded = useCallback((projectId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
        fetchWorktrees(projectId);
      }
      return next;
    });
  }, [fetchWorktrees]);

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

  const openAddDialog = useCallback((e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setWtName('');
    setWtBranch('');
    setWtCreateNew(false);
    setWtError('');
    setShowAddDialog(projectId);
  }, []);

  const handleAddWorktree = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showAddDialog) return;
    setWtError('');
    setWtSaving(true);
    try {
      const res = await fetch(`/api/projects/${showAddDialog}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: wtName, branch: wtBranch, createNewBranch: wtCreateNew }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setExpandedIds(prev => new Set(prev).add(showAddDialog));
      await fetchWorktrees(showAddDialog);
      setShowAddDialog(null);
    } catch (err) {
      setWtError((err as Error).message);
    } finally {
      setWtSaving(false);
    }
  };

  const handleDeleteWorktree = async (e: React.MouseEvent, projectId: string, worktreeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Remove this worktree? The worktree directory will be deleted.')) return;
    try {
      await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}`, { method: 'DELETE' });
      await fetchWorktrees(projectId);
    } catch {}
  };

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
        const isExpanded = expandedIds.has(project.id);
        const worktrees = worktreeMap[project.id] || [];

        return (
          <div key={project.id}>
            <div className={`group flex items-center gap-1 rounded-lg px-1 py-1 text-sm transition-colors ${
              isActive ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent hover:text-accent-foreground'
            }`}>
              <button
                onClick={() => toggleExpanded(project.id)}
                className="h-5 w-5 flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground"
              >
                {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <Link
                to={`/projects/${project.id}/chat`}
                className="flex items-center gap-2 flex-1 min-w-0 py-0.5"
              >
                <FolderOpen className="h-4 w-4 shrink-0" />
                <span className="truncate flex-1">{project.name}</span>
              </Link>
              <button
                onClick={(e) => openAddDialog(e, project.id)}
                className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-opacity"
                title="Add worktree"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
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
            </div>
            {isExpanded && worktrees.length > 0 && (
              <div className="ml-4 border-l pl-2 mb-1">
                {worktrees.map(wt => (
                  <Link
                    key={wt.id}
                    to={`/projects/${project.id}/worktrees/${wt.id}/chat`}
                    className={`group/wt flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors ${
                      location.pathname.includes(`/worktrees/${wt.id}`)
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate flex-1">{wt.name}</span>
                    <span className="text-[10px] text-muted-foreground truncate max-w-[60px]">{wt.branch}</span>
                    <button
                      onClick={(e) => handleDeleteWorktree(e, project.id, wt.id)}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/wt:opacity-100 hover:text-destructive transition-opacity"
                      title="Remove worktree"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </Link>
                ))}
              </div>
            )}
            {isExpanded && worktrees.length === 0 && (
              <div className="ml-4 border-l pl-2 mb-1">
                <p className="px-2 py-1 text-[10px] text-muted-foreground">No worktrees</p>
              </div>
            )}
          </div>
        );
      })}

      <Dialog open={!!showAddDialog} onOpenChange={(open) => !open && setShowAddDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Worktree</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddWorktree} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="wt-name">Name</Label>
              <Input
                id="wt-name"
                value={wtName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWtName(e.target.value)}
                placeholder="e.g. feature-auth"
                required
              />
              <p className="text-[10px] text-muted-foreground">Used as directory suffix and display name</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wt-branch">Branch</Label>
              <Input
                id="wt-branch"
                value={wtBranch}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWtBranch(e.target.value)}
                placeholder="e.g. feature/auth or main"
                required
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="wt-create-new"
                checked={wtCreateNew}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWtCreateNew(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="wt-create-new" className="text-sm font-normal">Create new branch</Label>
            </div>
            {wtError && <p className="text-sm text-destructive">{wtError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setShowAddDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={wtSaving}>
                {wtSaving ? 'Creating…' : 'Add Worktree'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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
  const [showSkillsDialog, setShowSkillsDialog] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'skills' | 'marketplace'>('skills');

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
        <div className="mb-2 px-3">
          <div className="flex items-center gap-2">
            <ClippyLogo className="h-10 w-10" />
            <h1 className="text-lg font-bold flex-1">Clippy</h1>
            <button
              onClick={() => setShowSkillsDialog(v => !v)}
              className={`relative z-[60] transition-colors shrink-0 ${showSkillsDialog ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              title="Settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="border-t mx-3 mb-2" />

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
              title={daemonConnected === true ? 'Daemon connected' : daemonConnected === false ? 'Daemon not running — click to start' : 'Checking daemon...'}
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

      <Dialog open={showSkillsDialog} onOpenChange={setShowSkillsDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <div className="flex gap-1 border-b">
            <button
              onClick={() => setSettingsTab('skills')}
              className={`px-3 py-1.5 text-sm transition-colors ${settingsTab === 'skills' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Skills & MCP
            </button>
            <button
              onClick={() => setSettingsTab('marketplace')}
              className={`px-3 py-1.5 text-sm transition-colors ${settingsTab === 'marketplace' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Marketplace
            </button>
          </div>
          <div className="flex-1 overflow-y-auto pt-2">
            {settingsTab === 'skills' && (() => {
              const match = location.pathname.match(/^\/projects\/([^/]+)/);
              return match ? <InstalledSkillsPanel projectId={match[1]} /> : <p className="text-sm text-muted-foreground">Select a project first.</p>;
            })()}
            {settingsTab === 'marketplace' && <SkillCatalog onInstallChanged={() => {}} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
