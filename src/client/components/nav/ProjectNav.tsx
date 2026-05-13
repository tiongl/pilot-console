'use client';

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router';
import { FolderOpen, Pin, ChevronRight, ChevronDown, GitBranch, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Project, Worktree } from '@/types';

interface Props {
  projects: Project[];
}

export default function ProjectNav({ projects }: Props) {
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
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
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then((data: { projects: Array<{ id: string; pinned?: number }> }) => {
        setPinnedIds(new Set(data.projects.filter(p => p.pinned).map(p => p.id)));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch('/api/sessions/active');
        if (res.ok) {
          const data = (await res.json()) as {
            sessions: Array<{ projectId: string; sessionId: string }>;
          };
          if (!cancelled) {
            setActiveProjectIds(new Set((data.sessions || []).map((s) => s.projectId)));
          }
        }
      } catch {
        // ignore fetch errors
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const fetchWorktrees = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/worktrees`);
      if (res.ok) {
        const data = (await res.json()) as { worktrees: Worktree[] };
        setWorktreeMap(prev => ({ ...prev, [projectId]: data.worktrees || [] }));
      }
    } catch {
      // ignore
    }
  }, []);

  const toggleExpanded = useCallback((projectId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
        // Fetch worktrees when expanding
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
      // Refresh worktrees and expand
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
    } catch {
      // ignore
    }
  };

  if (projects.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground text-center">
        No projects yet.{' '}
        <Link to="/projects/new" className="underline">
          Create one
        </Link>
      </p>
    );
  }

  // Sort: pinned first, then alphabetical
  const sorted = [...projects].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id) ? 1 : 0;
    const bPinned = pinnedIds.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sorted.map((project) => {
        const isExpanded = expandedIds.has(project.id);
        const worktrees = worktreeMap[project.id] || [];

        return (
          <div key={project.id}>
            <div className="group flex items-center gap-1 rounded-lg px-1 py-1 text-sm hover:bg-accent hover:text-accent-foreground transition-colors">
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
              {activeProjectIds.has(project.id) && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
              )}
            </div>
            {isExpanded && worktrees.length > 0 && (
              <div className="ml-4 border-l pl-2 mb-1">
                {worktrees.map(wt => (
                  <Link
                    key={wt.id}
                    to={`/projects/${project.id}/worktrees/${wt.id}/chat`}
                    className="group/wt flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate flex-1">{wt.name}</span>
                    <span className="text-[10px] text-muted-foreground truncate max-w-[60px]">{wt.branch}</span>
                    <button
                      onClick={(e) => handleDeleteWorktree(e, project.id, wt.id, wt.isManaged)}
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
                onChange={e => setWtName(e.target.value)}
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
                onChange={e => {
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
                  onChange={e => setWtExistingPath(e.target.value)}
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
                onChange={e => setWtBranch(e.target.value)}
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
                  onChange={e => setWtCreateNew(e.target.checked)}
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
