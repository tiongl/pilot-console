import { useEffect, useState, useCallback } from 'react';
import { Outlet, Link, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth-context';
import { Button } from '../../../components/ui/button';
import { Plus, Shield, LogOut, FolderOpen, Pin } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  repoPath: string;
  pinned?: number;
}

function ProjectNav({ projects }: { projects: Project[] }) {
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(new Set());
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
            setActiveProjectIds(new Set((data.sessions || []).map((s: any) => s.projectId)));
          }
        }
      } catch {}
    }
    poll();
    const interval = setInterval(poll, 5000);
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
      {sorted.map((project) => (
        <Link
          key={project.id}
          to={`/projects/${project.id}/chat`}
          className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
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
          {activeProjectIds.has(project.id) && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
          )}
        </Link>
      ))}
    </>
  );
}

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => setProjects(data.projects || []))
      .catch(() => {});
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
          {user?.role === 'admin' && (
            <Link
              to="/admin"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Shield className="h-4 w-4" />
              Admin
            </Link>
          )}
          <Button variant="ghost" onClick={handleLogout} className="w-full justify-start gap-3 px-3">
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
