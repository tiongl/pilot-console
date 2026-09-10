import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import {
  KanbanSquare,
  Table2,
  CalendarRange,
  ChevronDown,
  Lock,
  Globe,
  Plus,
  Settings2,
  Link2,
  Loader2,
  RefreshCw,
  Pencil,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { useGitHubResource } from '../hooks/useGitHubResource';
import { useStartIssueSession } from '../hooks/useStartIssueSession';
import { GitHubScopeGate } from '../components/github/GitHubScopeGate';
import { ProjectLinkPrompt } from '../components/github/ProjectLinkPrompt';
import { GitHubProjectPicker } from '../components/github/GitHubProjectPicker';
import { ProjectMetaDialog } from '../components/github/ProjectMetaDialog';
import { BoardCanvas } from '../components/github/BoardCanvas';
import { ProjectViewTable } from '../components/github/ProjectViewTable';
import { ProjectViewRoadmap } from '../components/github/ProjectViewRoadmap';
import { ReconcileDonePanel } from '../components/github/ReconcileDonePanel';
import type {
  GitHubProjectLink,
  GitHubProjectOverview,
  GitHubProjectView,
  GitHubProjectViewLayout,
  GitHubProjectViewSummary,
} from '@/types';

function layoutIcon(layout: GitHubProjectViewLayout) {
  if (layout === 'table') return <Table2 className="h-3.5 w-3.5" />;
  if (layout === 'roadmap') return <CalendarRange className="h-3.5 w-3.5" />;
  return <KanbanSquare className="h-3.5 w-3.5" />;
}

function visIcon(isPublic: boolean | undefined) {
  return isPublic ? (
    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
  ) : (
    <Lock className="h-3.5 w-3.5 text-muted-foreground" />
  );
}

/**
 * The Projects V2 explorer: a top-level project dropdown, that project's saved
 * views as tabs (honoring each view's board/table/roadmap layout), item-level
 * editing, project settings, a repeatable reconcile-to-Done prompt, and a
 * start/resume Copilot session action on issue cards.
 */
export default function ProjectBoardPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [links, setLinks] = useState<GitHubProjectLink[]>([]);
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [publicMap, setPublicMap] = useState<Record<string, boolean>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameView, setRenameView] = useState<GitHubProjectViewSummary | null>(null);

  const { start, startingIssue } = useStartIssueSession(id);

  const loadLinks = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/github/links`);
      const body = await res.json().catch(() => ({}));
      setLinks(body.links ?? []);
    } catch {
      // leave links empty; prompt will offer to create/link
    } finally {
      setLinksLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  // Best-effort visibility map for the dropdown (may 403 without project scope).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(id)}/github/linked-projects`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (cancelled || !b?.projects) return;
        const m: Record<string, boolean> = {};
        for (const p of b.projects) m[p.id] = p.public;
        setPublicMap(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  const selectedProjectId =
    searchParams.get('project') ||
    links.find((l) => l.isDefault)?.ghProjectId ||
    links[0]?.ghProjectId ||
    null;

  const overviewPath = selectedProjectId
    ? `/project-overview?ghProjectId=${encodeURIComponent(selectedProjectId)}`
    : '';
  const overviewState = useGitHubResource<{ overview: GitHubProjectOverview }>(id, overviewPath, {
    enabled: !!selectedProjectId,
  });
  const overview = overviewState.data?.overview ?? null;

  const viewParam = searchParams.get('view');
  const selectedViewNumber = viewParam ? Number(viewParam) : overview?.views[0]?.number ?? null;

  const viewPath =
    selectedProjectId && selectedViewNumber != null
      ? `/project-view?ghProjectId=${encodeURIComponent(selectedProjectId)}&view=${selectedViewNumber}`
      : '';
  const viewState = useGitHubResource<{ view: GitHubProjectView }>(id, viewPath, {
    enabled: !!viewPath,
  });
  const view = viewState.data?.view ?? null;

  const selectProject = (ghProjectId: string) =>
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('project', ghProjectId);
      p.delete('view');
      return p;
    });

  const selectView = (viewNumber: number) =>
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('view', String(viewNumber));
      return p;
    });

  const refreshAll = () => {
    overviewState.refresh();
    viewState.refresh();
  };

  const onCreated = async (link: GitHubProjectLink) => {
    await loadLinks();
    selectProject(link.ghProjectId);
  };

  if (!linksLoaded) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (links.length === 0) {
    return <ProjectLinkPrompt projectId={id} onLinked={loadLinks} />;
  }

  const currentProjectLabel = overview?.title ?? links.find((l) => l.ghProjectId === selectedProjectId)?.title ?? 'Project';
  const currentPublic = overview ? overview.public : selectedProjectId ? publicMap[selectedProjectId] : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Project dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-w-[16rem]" />}>
              {visIcon(currentPublic)}
              <span className="truncate">{currentProjectLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Projects</DropdownMenuLabel>
                {links.map((l) => (
                  <DropdownMenuItem key={l.ghProjectId} onClick={() => selectProject(l.ghProjectId)}>
                    {visIcon(publicMap[l.ghProjectId])}
                    <span className="truncate">{l.title}</span>
                    <span className="ml-auto text-xs text-muted-foreground">#{l.ghProjectNumber}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> New project…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLinkOpen(true)}>
                <Link2 className="h-3.5 w-3.5" /> Link existing…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* View tabs */}
          {overview && overview.views.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {overview.views.map((v) => {
                const active = v.number === selectedViewNumber;
                return (
                  <div
                    key={v.id}
                    className={`flex items-center rounded-md ${
                      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectView(v.number)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 text-sm transition-colors ${active ? 'font-medium' : ''}`}
                      title={`${v.name} (${v.layout})`}
                    >
                      {layoutIcon(v.layout)}
                      <span className="max-w-[10rem] truncate">{v.name}</span>
                    </button>
                    {active && overview.viewerCanUpdate && (
                      <button
                        type="button"
                        onClick={() => setRenameView(v)}
                        className="mr-1 rounded p-0.5 opacity-70 hover:bg-background hover:opacity-100"
                        title="Rename view"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {overview?.viewerCanUpdate && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setSettingsOpen(true)}
              title="Project settings"
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={refreshAll}
            disabled={overviewState.loading || viewState.loading}
            title="Refresh"
          >
            <RefreshCw
              className={`h-4 w-4 ${overviewState.loading || viewState.loading ? 'animate-spin' : ''}`}
            />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {overviewState.error ? (
          <GateOrError error={overviewState.error} onRetry={refreshAll} />
        ) : !overviewState.loaded ? (
          <LoadingSkeleton />
        ) : overview && overview.views.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This project has no saved views. Add a view on GitHub to see it here.
          </p>
        ) : (
          <ProjectViewContent
            consoleProjectId={id}
            ghProjectId={selectedProjectId!}
            view={view}
            loading={viewState.loading}
            loaded={viewState.loaded}
            error={viewState.error}
            onRefresh={refreshAll}
            onStartSession={start}
            startingIssue={startingIssue}
          />
        )}
      </div>

      {/* Dialogs */}
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} projectId={id} onCreated={onCreated} />

      <Dialog
        open={linkOpen}
        onOpenChange={(open) => {
          setLinkOpen(open);
          if (!open) void loadLinks();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link a GitHub Project</DialogTitle>
          </DialogHeader>
          <GitHubProjectPicker projectId={id} />
        </DialogContent>
      </Dialog>

      {overview && selectedProjectId && (
        <ProjectMetaDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          consoleProjectId={id}
          ghProjectId={selectedProjectId}
          overview={overview}
          onSaved={refreshAll}
        />
      )}

      {selectedProjectId && (
        <RenameViewDialog
          open={renameView != null}
          onOpenChange={(open) => {
            if (!open) setRenameView(null);
          }}
          consoleProjectId={id}
          ghProjectId={selectedProjectId}
          view={renameView}
          onSaved={refreshAll}
        />
      )}
    </div>
  );
}

function ProjectViewContent({
  consoleProjectId,
  ghProjectId,
  view,
  loading,
  loaded,
  error,
  onRefresh,
  onStartSession,
  startingIssue,
}: {
  consoleProjectId: string;
  ghProjectId: string;
  view: GitHubProjectView | null;
  loading: boolean;
  loaded: boolean;
  error: import('../hooks/useGitHubResource').GitHubError | null;
  onRefresh: () => void;
  onStartSession: (issueNumber: number) => void;
  startingIssue: number | null;
}) {
  if (error) return <GateOrError error={error} onRetry={onRefresh} />;
  if (!loaded && !view) return <LoadingSkeleton />;
  if (!view) return <LoadingSkeleton />;

  const body = (() => {
    if (view.layout === 'table') {
      return (
        <ProjectViewTable
          consoleProjectId={consoleProjectId}
          ghProjectId={ghProjectId}
          items={view.items}
          groupFieldName={view.groupFieldName}
          groupFieldId={view.groupFieldId}
          columns={view.columns}
          onRefresh={onRefresh}
          onStartSession={onStartSession}
          startingIssue={startingIssue}
        />
      );
    }
    if (view.layout === 'roadmap') {
      return (
        <ProjectViewRoadmap items={view.items} onStartSession={onStartSession} startingIssue={startingIssue} />
      );
    }
    return (
      <BoardCanvas
        consoleProjectId={consoleProjectId}
        ghProjectId={ghProjectId}
        groupFieldId={view.groupFieldId}
        columns={view.columns}
        items={view.items}
        onRefresh={onRefresh}
        onStartSession={onStartSession}
        startingIssue={startingIssue}
      />
    );
  })();

  return (
    <div className={`flex h-full flex-col ${loading ? 'opacity-60' : ''}`}>
      <ReconcileDonePanel
        consoleProjectId={consoleProjectId}
        ghProjectId={ghProjectId}
        groupFieldId={view.groupFieldId}
        columns={view.columns}
        items={view.items}
        onRefresh={onRefresh}
      />
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

function GateOrError({
  error,
  onRetry,
}: {
  error: import('../hooks/useGitHubResource').GitHubError;
  onRetry: () => void;
}) {
  const gate = GitHubScopeGate({ error });
  if (gate) return gate;
  return (
    <div className="mx-auto mt-8 max-w-lg rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm">
      <p className="font-semibold text-destructive">Failed to load from GitHub</p>
      <p className="mt-1 text-muted-foreground">{error.message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: (link: GitHubProjectLink) => void;
}) {
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/github/links/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Create failed (${res.status})`);
      toast.success('Project created and linked');
      setTitle('');
      onOpenChange(false);
      onCreated(body.link as GitHubProjectLink);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New GitHub Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={create} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="create-project-title">Project name</Label>
            <Input
              id="create-project-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q3 Roadmap"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !title.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameViewDialog({
  open,
  onOpenChange,
  consoleProjectId,
  ghProjectId,
  view,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consoleProjectId: string;
  ghProjectId: string;
  view: GitHubProjectViewSummary | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && view) setName(view.name);
  }, [open, view]);

  if (!view) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = name.trim();
    if (!t) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(consoleProjectId)}/github/project-view-name?ghProjectId=${encodeURIComponent(ghProjectId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ view: view.number, name: t }),
        },
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Rename failed (${res.status})`);
      toast.success('View renamed');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename view</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="view-name">View name</Label>
            <Input
              id="view-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={view.name}
            />
            <p className="text-[11px] text-muted-foreground">
              GitHub doesn&apos;t expose a view-rename API, so this name is stored locally in the console and only
              affects how the view appears here.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
