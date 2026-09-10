import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth-context';
import { Button } from '../components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import AgentPane from '../components/terminal/AgentPane';
import { CircleAlert, CircleCheck, CircleDot, Clock3, ExternalLink, FolderOpen, GitMerge, Plus, RotateCcw, ShieldAlert, ThumbsDown, Users } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  repoPath: string;
  description: string | null;
}

interface Digest {
  worktreeId: string;
  headline: string | null;
  status: 'in_progress' | 'blocked' | 'ready_to_merge' | 'idle' | null;
  detail: string | null;
}

interface MergeRequest {
  id: string;
  projectId: string;
  worktreeId: string;
  branch: string;
  status: 'pending' | 'approved' | 'merging' | 'merged' | 'rejected' | 'conflict';
  priority: 'normal' | 'urgent';
  summary: string | null;
}

interface MergeLock {
  projectId: string;
  heldByWorktreeId: string | null;
  expiresAt: string | null;
}

interface OverviewWorker {
  sessionId: string;
  projectId: string | null;
  projectName: string;
  worktreeId: string | null;
  status: 'idle' | 'busy';
  mode: string;
}

interface OverviewThread {
  id: string;
  projectId: string;
  projectName: string;
  title: string | null;
  question: string;
  status: string;
  updatedAt: string;
}

interface OverviewHistory {
  id: string;
  projectId: string;
  projectName: string;
  actor: string;
  action: string;
  reasoning: string | null;
  riskLevel: string | null;
  createdAt: string;
}

interface OverviewBriefing {
  id: string;
  projectId: string;
  projectName: string;
  summary: string;
  createdAt: string;
}

const DIGEST_META = {
  in_progress: { label: 'In progress', icon: CircleDot, className: 'text-blue-500' },
  blocked: { label: 'Blocked', icon: CircleAlert, className: 'text-red-500' },
  ready_to_merge: { label: 'Ready to merge', icon: CircleCheck, className: 'text-green-500' },
  idle: { label: 'Idle', icon: Clock3, className: 'text-muted-foreground' },
} as const;

export default function HomePage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [digests, setDigests] = useState<Record<string, Digest[]>>({});
  const [mergeRequests, setMergeRequests] = useState<MergeRequest[]>([]);
  const [mergeLocks, setMergeLocks] = useState<Record<string, MergeLock | null>>({});
  const [workers, setWorkers] = useState<OverviewWorker[]>([]);
  const [leadThreads, setLeadThreads] = useState<OverviewThread[]>([]);
  const [history, setHistory] = useState<OverviewHistory[]>([]);
  const [briefings, setBriefings] = useState<OverviewBriefing[]>([]);

  const refreshMergeQueue = () => {
    Promise.all([
      fetch('/api/merge-queue').then((response) => response.json()),
      fetch('/api/projects').then((response) => response.json()),
    ]).then(async ([queue, projectData]) => {
      const nextProjects = projectData.projects || [];
      setMergeRequests(queue.requests || []);
      const lockEntries = await Promise.all(nextProjects.map(async (project: Project) => {
        const response = await fetch(`/api/projects/${project.id}/merge-lock`);
        const body = response.ok ? await response.json() : { lock: null };
        return [project.id, body.lock] as const;
      }));
      setMergeLocks(Object.fromEntries(lockEntries));
    }).catch(() => {});
  };

  const refreshOverview = () => {
    fetch('/api/chief-of-staff/overview')
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!data) return;
        setWorkers(data.workers || []);
        setLeadThreads(data.threads || []);
        setHistory(data.history || []);
        setBriefings(data.briefings || []);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(async data => {
        const nextProjects = data.projects || [];
        setProjects(nextProjects);
        const entries = await Promise.all(nextProjects.map(async (project: Project) => {
          const response = await fetch(`/api/projects/${project.id}/digests`);
          const body = response.ok ? await response.json() : { digests: [] };
          return [project.id, body.digests || []] as const;
        }));
        setDigests(Object.fromEntries(entries));
      })
      .catch(() => {});
    refreshMergeQueue();
    refreshOverview();
    const interval = setInterval(refreshOverview, 5000);
    return () => clearInterval(interval);
  }, []);

  const updateMergeRequest = async (request: MergeRequest, action: 'approve' | 'reject') => {
    const response = await fetch(`/api/projects/${request.projectId}/merge-queue/${request.id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'reject' ? { reason: 'Rejected from dashboard' } : {}),
    });
    if (response.ok) refreshMergeQueue();
  };

  const forceReleaseLock = async (projectId: string) => {
    const response = await fetch(`/api/projects/${projectId}/merge-lock/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Force-released from dashboard' }),
    });
    if (response.ok) refreshMergeQueue();
  };

  const spotCheck = async (projectId: string, worktreeId: string) => {
    const response = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/digest/spot-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'User requested a digest trust check' }),
    });
    if (!response.ok) return;
    const body = await response.json();
    setDigests((current) => ({
      ...current,
      [projectId]: (current[projectId] || []).map((digest) => digest.worktreeId === worktreeId ? body.digest : digest),
    }));
  };

  return (
    <div className="flex flex-col gap-8 p-8">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Chief of Staff</CardTitle>
          <CardDescription>Portfolio-level prioritization and project handoffs</CardDescription>
        </CardHeader>
        <div className="h-[28rem] px-4 pb-4">
          <AgentPane active sessionKind="chief_of_staff" />
        </div>
      </Card>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold">Welcome back, {user?.displayName ?? 'there'}</h2>
          <p className="text-muted-foreground mt-1">GitHub Copilot CLI — Web Interface</p>
        </div>
        <Link to="/projects/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleDot className="h-4 w-4 text-blue-500" />
              Running workers
              <span className="ml-auto text-sm font-normal text-muted-foreground">{workers.length}</span>
            </CardTitle>
            <CardDescription>All active worktree agent sessions</CardDescription>
          </CardHeader>
          <div className="space-y-2 px-6 pb-5">
            {workers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No worker sessions are running.</p>
            ) : workers.map((worker) => (
              <Link
                key={worker.sessionId}
                to={worker.projectId && worker.worktreeId
                  ? `/projects/${worker.projectId}/worktrees/${worker.worktreeId}/chat`
                  : `/projects/${worker.projectId || ''}/chat`}
                className="flex items-center gap-2 rounded border p-2 text-sm hover:bg-accent"
              >
                <span className={`h-2 w-2 rounded-full ${worker.status === 'busy' ? 'animate-pulse bg-yellow-500' : 'bg-green-500'}`} />
                <span className="min-w-0 flex-1 truncate">{worker.projectName}</span>
                <span className="max-w-28 truncate font-mono text-[11px] text-muted-foreground">{worker.worktreeId || worker.mode}</span>
              </Link>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleAlert className="h-4 w-4 text-amber-500" />
              Unfinished Project Lead conversations
              <span className="ml-auto text-sm font-normal text-muted-foreground">{leadThreads.length}</span>
            </CardTitle>
            <CardDescription>Open handoffs and decisions awaiting closure</CardDescription>
          </CardHeader>
          <div className="space-y-2 px-6 pb-5">
            {leadThreads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No unfinished Project Lead conversations.</p>
            ) : leadThreads.map((thread) => (
              <Link key={thread.id} to={`/projects/${thread.projectId}/lead`} className="block rounded border p-2 hover:bg-accent">
                <div className="truncate text-sm font-medium">{thread.title || thread.question}</div>
                <div className="text-xs text-muted-foreground">{thread.projectName} · {thread.status}</div>
              </Link>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              Recent history
            </CardTitle>
            <CardDescription>Latest Project Lead briefings and audited actions</CardDescription>
          </CardHeader>
          <div className="space-y-2 px-6 pb-5">
            {(() => {
              const merged = [
                ...briefings.map((b) => ({ id: `brief-${b.id}`, projectId: b.projectId, projectName: b.projectName, label: 'Briefed CoS', detail: b.summary, createdAt: b.createdAt })),
                ...history.map((h) => ({ id: `hist-${h.id}`, projectId: h.projectId, projectName: h.projectName, label: h.action, detail: h.reasoning || h.actor, createdAt: h.createdAt })),
              ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 6);
              return merged.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent activity.</p>
              ) : merged.map((entry) => (
                <Link key={entry.id} to={`/projects/${entry.projectId}/lead`} className="block rounded border p-2 hover:bg-accent">
                  <div className="text-sm font-medium">{entry.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{entry.projectName} · {entry.detail}</div>
                </Link>
              ));
            })()}
          </div>
        </Card>
      </div>

      {mergeRequests.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5" />
              Merge queue
            </CardTitle>
            <CardDescription>Project Leads approve merges; server-side execution creates the pull request.</CardDescription>
          </CardHeader>
          <div className="space-y-3 px-6 pb-6">
            {mergeRequests.map((request) => {
              const project = projects.find((item) => item.id === request.projectId);
              const lock = mergeLocks[request.projectId];
              const actionable = request.status === 'pending';
              return (
                <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{project?.name ?? request.projectId}</span>
                      <span className="font-mono text-xs text-muted-foreground">{request.branch}</span>
                      {request.priority === 'urgent' && <span className="text-xs text-orange-600">urgent</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{request.summary || 'No summary provided'} · {request.status}</div>
                    {lock && (
                      <div className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                        <ShieldAlert className="h-3 w-3" />
                        Merge lock held until {lock.expiresAt || 'unknown'}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {actionable && (
                      <>
                        <Button size="sm" onClick={() => updateMergeRequest(request, 'approve')}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => updateMergeRequest(request, 'reject')}>Reject</Button>
                      </>
                    )}
                    {lock && (
                      <Button size="sm" variant="ghost" title="Force release merge lock" onClick={() => forceReleaseLock(request.projectId)}>
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                    {request.status === 'merging' && (
                      <ExternalLink className="h-4 w-4 text-muted-foreground" aria-label="Pull request created" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {projects.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="text-center py-12">
            <FolderOpen className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <CardTitle>No projects yet</CardTitle>
            <CardDescription>
              Create a project to start using Copilot CLI with a specific repo.
            </CardDescription>
            <Link to="/projects/new" className="mt-4 inline-block">
              <Button>Create your first project</Button>
            </Link>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id} className="flex h-full flex-col transition-colors hover:bg-accent/50">
              <Link to={`/projects/${project.id}/chat`} className="flex-1">
                <CardHeader>
                  <FolderOpen className="h-8 w-8 mb-2 text-primary" />
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription className="space-y-1">
                    <span className="block font-mono text-xs truncate">{project.repoPath}</span>
                    {project.description && (
                      <span className="block">{project.description}</span>
                    )}
                  </CardDescription>
                  {(digests[project.id] || []).length > 0 && (
                    <div className="mt-3 space-y-2 border-t pt-3">
                      {(digests[project.id] || []).map((digest) => {
                        const meta = DIGEST_META[digest.status || 'idle'];
                        const Icon = meta.icon;
                        return (
                          <div key={digest.worktreeId} className="flex items-start gap-2 text-xs">
                            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${meta.className}`} />
                            <div className="min-w-0">
                              <div className="font-medium">{digest.headline || meta.label}</div>
                              {digest.detail && <div className="truncate text-muted-foreground">{digest.detail}</div>}
                            </div>
                            <button
                              type="button"
                              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                              title="Live spot-check this digest"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void spotCheck(project.id, digest.worktreeId);
                              }}
                            >
                              <ThumbsDown className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardHeader>
              </Link>
              <div className="border-t px-6 py-3">
                <Link to={`/projects/${project.id}/lead`} onClick={(event) => event.stopPropagation()}>
                  <Button variant="outline" size="sm" className="w-full gap-2">
                    <Users className="h-3.5 w-3.5" />
                    Chat with Project Lead
                  </Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
