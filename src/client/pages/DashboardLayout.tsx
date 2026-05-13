import React, { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router';
import { useAuth } from '../lib/auth-context';
import { useTheme, THEMES, type ThemeId } from '../lib/theme-context';
import { useSplit, type SplitContent } from '../lib/split-context';
import { Button } from '../components/ui/button';
import { Plus, LogOut, FolderOpen, Pin, Palette, Settings, ChevronRight, ChevronDown, GitBranch, Trash2, Clock, Zap, Wrench, Columns2 } from 'lucide-react';
import { SkillCatalog, InstalledSkillsPanel } from '../pages/ProjectSkillsPage';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { PilotConsoleLogo } from '../components/PilotConsoleLogo';
import { useAutomation } from '../lib/automation-context';

const ProjectLayout = lazy(() => import('./ProjectLayout'));
const WorktreeLayout = lazy(() => import('./WorktreeLayout'));
const KeepAliveChat = lazy(() => import('../components/KeepAliveChat'));
const AutomationHistoryCore = lazy(() => import('./AutomationHistoryPage').then(m => ({ default: m.AutomationHistoryCore })));
const SchedulesPage = lazy(() => import('./SchedulesPage'));

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
  isManaged: boolean;
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

function ProjectNav({
  projects,
  onProjectClick,
  onWorktreeClick,
}: {
  projects: Project[];
  onProjectClick?: (projectId: string) => void;
  onWorktreeClick?: (projectId: string, worktreeId: string) => void;
}) {
  const location = useLocation();
  const [projectStatuses, setProjectStatuses] = useState<Map<string, ProjectSessionInfo>>(new Map());
  const [worktreeStatuses, setWorktreeStatuses] = useState<Map<string, ProjectSessionInfo>>(new Map());
  const [projectBranches, setProjectBranches] = useState<Map<string, string>>(new Map());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(
    new Set(projects.filter(p => p.pinned).map(p => p.id))
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const active = projects.find(p => location.pathname.startsWith(`/projects/${p.id}`));
    return active ? new Set([active.id]) : new Set();
  });
  const [worktreeMap, setWorktreeMap] = useState<Record<string, Worktree[]>>({});
  const [showAddDialog, setShowAddDialog] = useState<string | null>(null);
  const [wtName, setWtName] = useState('');
  const [wtBranch, setWtBranch] = useState('');
  const [wtCreateNew, setWtCreateNew] = useState(false);
  const [wtUseExisting, setWtUseExisting] = useState(false);
  const [wtExistingPath, setWtExistingPath] = useState('');
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
            const wtStatuses = new Map<string, ProjectSessionInfo>();
            for (const s of data.sessions || []) {
              if (s.worktreeId) {
                const existing = wtStatuses.get(s.worktreeId);
                if (!existing || statusPriority(s.status) > statusPriority(existing.status)) {
                  wtStatuses.set(s.worktreeId, { status: s.status, exitCode: s.exitCode });
                }
              } else {
                // Only track non-worktree sessions for the main branch status
                const existing = statuses.get(s.projectId);
                if (!existing || statusPriority(s.status) > statusPriority(existing.status)) {
                  statuses.set(s.projectId, { status: s.status, exitCode: s.exitCode });
                }
              }
            }
            setProjectStatuses(statuses);
            setWorktreeStatuses(wtStatuses);
          }
        }
      } catch {}
    }
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Determine the currently active project from the URL
  const activeProjectId = projects.find(p => location.pathname.startsWith(`/projects/${p.id}`))?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    // Fetch branch for a single project and update the map incrementally
    async function fetchBranch(projectId: string) {
      try {
        const res = await fetch(`/api/projects/${projectId}/git-status`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (data.branch) {
            setProjectBranches(prev => {
              const next = new Map(prev);
              next.set(projectId, data.branch);
              return next;
            });
          }
        }
      } catch {}
    }
    // Initial load: fetch all branches once
    projects.forEach(p => fetchBranch(p.id));

    // Slow poll: only refresh the active project's branch (60s)
    const interval = setInterval(() => {
      if (activeProjectId) fetchBranch(activeProjectId);
    }, 60_000);

    // Event-driven: refresh branch when git activity detected
    const onGitChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId: string };
      if (!cancelled) fetchBranch(detail.projectId);
    };
    window.addEventListener('git-changed', onGitChanged);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('git-changed', onGitChanged);
    };
  }, [projects, activeProjectId]);

  const fetchWorktrees = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/worktrees`);
      if (res.ok) {
        const data = await res.json();
        setWorktreeMap(prev => ({ ...prev, [projectId]: data.worktrees || [] }));
      }
    } catch {}
  }, []);

  // Fetch worktrees for all projects on mount
  useEffect(() => {
    projects.forEach(p => fetchWorktrees(p.id));
  }, [projects, fetchWorktrees]);

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
    setWtUseExisting(false);
    setWtExistingPath('');
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
        body: JSON.stringify({
          name: wtName,
          branch: wtBranch,
          createNewBranch: wtUseExisting ? false : wtCreateNew,
          worktreePath: wtUseExisting ? wtExistingPath : undefined,
        }),
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

  const handleDeleteWorktree = async (e: React.MouseEvent, projectId: string, worktreeId: string, isManaged: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const message = isManaged
      ? 'Remove this worktree? The worktree directory will be deleted.'
      : 'Remove this worktree from Pilot Console? The existing directory will not be deleted.';
    if (!confirm(message)) return;
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
            <div className={`group flex items-center gap-1 rounded-lg px-1 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground`}>
              <button
                onClick={() => toggleExpanded(project.id)}
                className="flex items-center gap-2 flex-1 min-w-0 py-0.5 text-left"
              >
                {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <FolderOpen className="h-4 w-4 shrink-0" />
                <span className="truncate flex-1">{project.name}</span>
              </button>
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
            </div>
            {/* Branch subpanel */}
            {isExpanded && projectBranches.get(project.id) && (
              onProjectClick ? (
                <button
                  onClick={() => onProjectClick(project.id)}
                  className={`ml-7 w-[calc(100%-1.75rem)] pr-2 flex items-center gap-2 px-1 py-1 text-left text-sm transition-colors cursor-pointer rounded-md ${
                    isActive && !location.pathname.includes('/worktrees/')
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                >
                  <GitBranch className="h-4 w-4 shrink-0" />
                  <span className="truncate flex-1 text-left">{projectBranches.get(project.id)}</span>
                  <span className="ml-auto w-3 flex items-center justify-center shrink-0"><StatusDot info={projectStatuses.get(project.id)} /></span>
                </button>
              ) : (
                <Link
                  to={`/projects/${project.id}/chat`}
                  className={`ml-7 w-[calc(100%-1.75rem)] pr-2 flex items-center gap-2 px-1 py-1 text-left text-sm transition-colors rounded-md ${
                    isActive && !location.pathname.includes('/worktrees/')
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                >
                  <GitBranch className="h-4 w-4 shrink-0" />
                  <span className="truncate flex-1 text-left">{projectBranches.get(project.id)}</span>
                  <span className="ml-auto w-3 flex items-center justify-center shrink-0"><StatusDot info={projectStatuses.get(project.id)} /></span>
                </Link>
              )
            )}
            {isExpanded && worktrees.length > 0 && (
              <div className="mb-1">
                {worktrees.map(wt => {
                  const wtActive = location.pathname.includes(`/worktrees/${wt.id}`);
                  const className = `group/wt ml-7 w-[calc(100%-1.75rem)] pr-2 flex items-center gap-2 px-1 py-1 text-left text-sm transition-colors rounded-md ${
                    wtActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`;
                  const content = (
                    <>
                      <GitBranch className="h-4 w-4 shrink-0" />
                      <span className="truncate flex-1 text-left">{wt.name}</span>
                      <button
                        onClick={(e) => handleDeleteWorktree(e, project.id, wt.id, wt.isManaged)}
                        className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/wt:opacity-100 hover:text-destructive transition-opacity"
                        title="Remove worktree"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                      <span className="w-3 flex items-center justify-center shrink-0"><StatusDot info={worktreeStatuses.get(wt.id)} /></span>
                    </>
                  );
                  return onWorktreeClick ? (
                    <button
                      key={wt.id}
                      onClick={() => onWorktreeClick(project.id, wt.id)}
                      className={className}
                    >
                      {content}
                    </button>
                  ) : (
                    <Link
                      key={wt.id}
                      to={`/projects/${project.id}/worktrees/${wt.id}/chat`}
                      className={className}
                    >
                      {content}
                    </Link>
                  );
                })}
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
                placeholder={wtUseExisting ? 'Defaults to folder name' : 'e.g. feature-auth'}
                required={!wtUseExisting}
              />
              <p className="text-[10px] text-muted-foreground">
                {wtUseExisting ? 'Optional display name for the existing worktree' : 'Used as directory suffix and display name'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="wt-use-existing"
                checked={wtUseExisting}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setWtUseExisting(e.target.checked);
                  if (e.target.checked) setWtCreateNew(false);
                }}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="wt-use-existing" className="text-sm font-normal">Attach existing worktree</Label>
            </div>
            {wtUseExisting && (
              <div className="space-y-2">
                <Label htmlFor="wt-existing-path">Worktree path</Label>
                <Input
                  id="wt-existing-path"
                  value={wtExistingPath}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWtExistingPath(e.target.value)}
                  placeholder="C:\path\to\existing-worktree"
                  required
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="wt-branch">Branch</Label>
              <Input
                id="wt-branch"
                value={wtBranch}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWtBranch(e.target.value)}
                placeholder={wtUseExisting ? 'Detected automatically if blank' : 'e.g. feature/auth or main'}
                required={!wtUseExisting}
              />
            </div>
            {!wtUseExisting && (
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
            )}
            {wtError && <p className="text-sm text-destructive">{wtError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setShowAddDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={wtSaving}>
                {wtSaving ? 'Adding…' : 'Add Worktree'}
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
  const { paneCount, panes, activePaneIndex, setPaneCount, setPaneContent, setActivePaneIndex } = useSplit();
  const [projects, setProjects] = useState<Project[]>([]);
  const [daemonConnected, setDaemonConnected] = useState<boolean | null>(null);
  const [showSkillsDialog, setShowSkillsDialog] = useState(false);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'skills' | 'marketplace'>('skills');
  const { badgeCount, schedules } = useAutomation();
  const [splitRatio, setSplitRatio] = useState(0.5);
  const sidebarRef = useRef<HTMLElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);

  const onSeparatorMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    // Measure the draggable region (between header and footer)
    const sidebarRect = sidebar.getBoundingClientRect();
    // Approximate fixed regions: header ~60px, section headers ~50px, footer ~80px, separator ~10px
    const fixedHeight = 200;
    const availableHeight = sidebarRect.height - fixedHeight;
    const startY = e.clientY;
    const startRatio = splitRatio;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      const newRatio = Math.min(0.85, Math.max(0.15, startRatio + delta / availableHeight));
      setSplitRatio(newRatio);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [splitRatio]);

  const onSidebarResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(400, Math.max(180, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Render standalone pane content
  const renderPaneContent = useCallback((content: SplitContent) => {
    if (!content) {
      return (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          <div className="text-center">
            <Columns2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Click a project or page to open here</p>
          </div>
        </div>
      );
    }
    if (content.type === 'project') {
      return (
        <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
          <ProjectLayout projectId={content.projectId} key={content.projectId}>
            <KeepAliveChat projectId={content.projectId} />
          </ProjectLayout>
        </Suspense>
      );
    }
    if (content.type === 'worktree') {
      return (
        <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
          <WorktreeLayout projectId={content.projectId} worktreeId={content.worktreeId} key={`${content.projectId}-${content.worktreeId}`}>
            <KeepAliveChat projectId={content.projectId} worktreeId={content.worktreeId} />
          </WorktreeLayout>
        </Suspense>
      );
    }
    return (
      <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
        {content.path === '/automation/config' ? (
          <SchedulesPage />
        ) : (
          <AutomationHistoryCore
            key={content.path}
            scheduleFilter={new URLSearchParams(content.path.split('?')[1] || '').get('schedule') || undefined}
            onNavigate={(path) => {
              const paneIdx = panes.indexOf(content);
              if (paneIdx >= 0) setPaneContent(paneIdx + 1, { type: 'automation', path });
            }}
          />
        )}
      </Suspense>
    );
  }, [panes, setPaneContent]);
  const handleSidebarNav = useCallback((target: NonNullable<SplitContent>) => {
    if (activePaneIndex > 0) {
      setPaneContent(activePaneIndex, target);
    } else if (target.type === 'project') {
      navigate(`/projects/${target.projectId}/chat`);
    } else if (target.type === 'worktree') {
      navigate(`/projects/${target.projectId}/worktrees/${target.worktreeId}/chat`);
    } else {
      navigate(target.path);
    }
  }, [activePaneIndex, setPaneContent, navigate]);

  const handleSplitProjectClick = useCallback((projectId: string) => {
    handleSidebarNav({ type: 'project', projectId });
  }, [handleSidebarNav]);

  const handleSplitWorktreeClick = useCallback((projectId: string, worktreeId: string) => {
    handleSidebarNav({ type: 'worktree', projectId, worktreeId });
  }, [handleSidebarNav]);

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
    const interval = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-background">
      <aside ref={sidebarRef} className="flex flex-col border-r bg-muted/40 px-3 py-4 shrink-0" style={{ width: sidebarWidth }}>
        <div className="mb-2 px-3">
          <div className="flex items-center gap-2">
            <PilotConsoleLogo className="h-10 w-10" />
            <h1 className="text-lg font-bold flex-1 tracking-tight leading-tight">Pilot Console</h1>
            <div className="relative shrink-0">
              <button
                onClick={() => setShowLayoutMenu(v => !v)}
                className={`transition-colors ${paneCount > 1 ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                aria-label="Layout columns"
                title="Layout columns"
              >
                <Columns2 className="h-3.5 w-3.5" />
              </button>
              {showLayoutMenu && (
                <>
                  <div className="fixed inset-0 z-[70]" onClick={() => setShowLayoutMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 z-[80] bg-popover border rounded-md shadow-md p-1 flex gap-0.5">
                    {[1, 2, 3, 4].map(n => (
                      <button
                        key={n}
                        onClick={() => { setPaneCount(n); setShowLayoutMenu(false); }}
                        className={`p-1.5 rounded flex items-center hover:bg-accent ${paneCount === n ? 'text-primary bg-accent' : 'text-foreground'}`}
                        aria-label={`${n} ${n === 1 ? 'column' : 'columns'}`}
                        title={`${n} ${n === 1 ? 'column' : 'columns'}`}
                      >
                        <span className="flex gap-0.5">{Array.from({ length: n }, (_, i) => <span key={i} className="w-2 h-3 border rounded-[1px]" />)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
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

        {/* Projects section — top half */}
        <div className="flex items-center justify-between px-3 mb-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Projects</span>
          <div className="flex items-center gap-1">
            <Link to="/projects/new" className="text-muted-foreground hover:text-foreground transition-colors">
              <Plus className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
        <nav style={{ flex: `${splitRatio} 1 0`, minHeight: 0 }} className="flex flex-col gap-0.5 overflow-y-auto">
          <ProjectNav
            projects={projects}
            onProjectClick={paneCount > 1 ? handleSplitProjectClick : undefined}
            onWorktreeClick={paneCount > 1 ? handleSplitWorktreeClick : undefined}
          />
        </nav>

        {/* Resizable separator */}
        <div
          onMouseDown={onSeparatorMouseDown}
          className="mx-3 my-1 flex items-center cursor-row-resize select-none shrink-0 group"
          style={{ padding: '4px 0' }}
          title="Drag to resize"
        >
          <div className="flex-1 border-t border-border group-hover:border-primary transition-colors" />
          <div className="mx-2 flex gap-0.5">
            <span className="block h-0.5 w-0.5 rounded-full bg-muted-foreground/50 group-hover:bg-primary transition-colors" />
            <span className="block h-0.5 w-0.5 rounded-full bg-muted-foreground/50 group-hover:bg-primary transition-colors" />
            <span className="block h-0.5 w-0.5 rounded-full bg-muted-foreground/50 group-hover:bg-primary transition-colors" />
          </div>
          <div className="flex-1 border-t border-border group-hover:border-primary transition-colors" />
        </div>

        {/* Automation section — bottom half */}
        <div className="flex items-center justify-between px-3 mb-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            Automation
            {badgeCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-medium px-1">
                {badgeCount > 99 ? '99+' : badgeCount}
              </span>
            )}
          </span>
          <button onClick={() => handleSidebarNav({ type: 'automation', path: '/automation/config' })} className="text-muted-foreground hover:text-foreground transition-colors" title="Configure automations">
            <Wrench className="h-3.5 w-3.5" />
          </button>
        </div>
        <nav style={{ flex: `${1 - splitRatio} 1 0`, minHeight: 0 }} className="flex flex-col gap-0.5 overflow-y-auto">
          <button
            onClick={() => handleSidebarNav({ type: 'automation', path: '/automation' })}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors text-left ${
              location.pathname === '/automation' && !location.search
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            <Clock className="h-3.5 w-3.5" />
            All
          </button>
          {schedules.map(s => {
            const isActive = location.pathname === '/automation' && location.search === `?schedule=${s.id}`;
            return (
              <button
                key={s.id}
                onClick={() => handleSidebarNav({ type: 'automation', path: `/automation?schedule=${s.id}` })}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors truncate text-left ${
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'hover:bg-accent hover:text-accent-foreground'
                }`}
                title={s.name}
              >
                <Zap className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{s.name}</span>
              </button>
            );
          })}
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
      <div
        onMouseDown={onSidebarResizeMouseDown}
        className="w-1 hover:w-1.5 bg-transparent hover:bg-primary/30 cursor-col-resize shrink-0 transition-all"
      />

      {paneCount > 1 ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Pane 0: router outlet */}
          <main
            className={`flex flex-col overflow-hidden ${activePaneIndex === 0 ? 'ring-2 ring-primary/50 ring-inset' : ''}`}
            style={{ flex: '1 1 0', minWidth: 0 }}
            onClick={() => setActivePaneIndex(0)}
          >
            <Outlet />
          </main>
          {/* Extra panes 1..N-1 with dividers */}
          {panes.slice(0, paneCount - 1).map((content, i) => (
            <React.Fragment key={i}>
              <div
                className="w-1 bg-border hover:bg-primary/50 cursor-col-resize shrink-0 transition-colors"
                title="Drag to resize"
              />
              <div
                className={`flex flex-col overflow-hidden ${activePaneIndex === i + 1 ? 'ring-2 ring-primary/50 ring-inset' : ''}`}
                style={{ flex: '1 1 0', minWidth: 0 }}
                onClick={() => setActivePaneIndex(i + 1)}
              >
                {renderPaneContent(content)}
              </div>
            </React.Fragment>
          ))}
        </div>
      ) : (
        <main className="flex flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      )}

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
