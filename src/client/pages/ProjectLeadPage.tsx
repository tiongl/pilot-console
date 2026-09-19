import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Compass, Users, ChevronRight, PanelRightClose, PanelRightOpen, Server, FileCode } from 'lucide-react';
import AgentPane from '../components/terminal/AgentPane';
import ProjectTodoPanel from '../components/project/ProjectTodoPanel';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';

interface AuditEntry {
  id: string;
  action: string;
  reasoning: string | null;
  risk_level: string | null;
  subject_id: string | null;
  created_at: string;
}
interface DecisionThread {
  id: string;
  title: string | null;
  question: string;
  status: string;
  decision: string | null;
  rationale: string | null;
  alternatives_considered: string | null;
  user_verdict: string | null;
  follow_up_actions: string | null;
  created_at: string;
  updated_at: string;
}
interface ProjectMemory { summary: string; source: string | null; updatedAt: string | null; }

const SIDE_PANEL_LS_KEY = 'pilot-console:lead-side-panel';
interface Delegation {
  id: string;
  worktreeId: string;
  /** The worker's own Copilot session. Without it a worker tab has to guess. */
  sessionId: string | null;
  title: string;
  status: 'planning' | 'awaiting_plan_review' | 'working' | 'blocked' | 'done' | 'cancelled' | 'closed';
  note: string | null;
  unread: number;
}

interface ManagedServer {
  id: string;
  projectId: string;
  name: string;
  command: string;
  status: 'pending' | 'starting' | 'running' | 'stopped' | 'failed';
  exitCode: number | null;
  running: boolean;
}

const SERVER_TAB_PREFIX = 'srv-';
const ARTIFACT_TAB_PREFIX = 'art-';

/** Worker lifecycle states that still count as "live" — everything else is finished. */
const WORKER_ACTIVE_STATUSES = new Set(['planning', 'awaiting_plan_review', 'working', 'blocked']);

interface LavishArtifactTab {
  id: string;
  projectId: string;
  name: string;
  status: 'starting' | 'ready' | 'failed' | 'stopped';
  sessionKey: string | null;
  proxyPath: string | null;
}

export default function ProjectLeadPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <div className="p-6 text-muted-foreground">Project not found</div>;

  return <ProjectLeadContent projectId={id} />;
}

function ProjectLeadContent({ projectId }: { projectId: string }) {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [threads, setThreads] = useState<DecisionThread[]>([]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [refreshingMemory, setRefreshingMemory] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // Remembered per browser so the pane does not reappear on every visit.
  const [sidePanelOpen, setSidePanelOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDE_PANEL_LS_KEY) !== 'hidden';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDE_PANEL_LS_KEY, sidePanelOpen ? 'shown' : 'hidden');
    } catch {
      /* private mode — the toggle still works for this session */
    }
  }, [sidePanelOpen]);

  const refresh = () => {
    Promise.all([
      fetch(`/api/projects/${projectId}/audit-log`).then((r) => r.json()),
      fetch(`/api/projects/${projectId}/decision-threads`).then((r) => r.json()),
      fetch(`/api/projects/${projectId}/memory`).then((r) => r.json()),
    ]).then(([auditData, threadData, memoryData]) => {
      setAudit(auditData.entries || []);
      setThreads(threadData.threads || []);
      setMemory(memoryData ?? null);
    }).catch(() => {});
  };

  const refreshMemory = async () => {    setRefreshingMemory(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/refresh`, { method: 'POST' });
      if (response.ok) setMemory(await response.json());
    } finally {
      setRefreshingMemory(false);
    }
  };

  const resolveThread = async (threadId: string, status: 'resolved' | 'open') => {
    setResolvingId(threadId);
    try {
      const response = await fetch(`/api/projects/${projectId}/decision-threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, userVerdict: status === 'resolved' ? 'Closed from Project Lead page' : null }),
      });
      if (response.ok) {
        const data = await response.json() as { thread?: DecisionThread };
        if (data.thread) setThreads((prev) => prev.map((t) => (t.id === threadId ? data.thread! : t)));
      }
    } finally {
      setResolvingId(null);
    }
  };

  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [servers, setServers] = useState<ManagedServer[]>([]);
  const [artifacts, setArtifacts] = useState<LavishArtifactTab[]>([]);
  const [activeTab, setActiveTab] = useState<string>('lead');

  const refreshDelegations = useCallback(() => {
    fetch(`/api/projects/${projectId}/delegations`)
      .then((r) => (r.ok ? r.json() : { delegations: [] }))
      .then((data: { delegations: Delegation[] }) => setDelegations(data.delegations || []))
      .catch(() => {});
  }, [projectId]);

  const refreshServers = useCallback(() => {
    fetch(`/api/projects/${projectId}/servers`)
      .then((r) => (r.ok ? r.json() : { servers: [] }))
      .then((data: { servers: ManagedServer[] }) => setServers(data.servers || []))
      .catch(() => {});
  }, [projectId]);

  const refreshArtifacts = useCallback(() => {
    fetch(`/api/projects/${projectId}/lavish`)
      .then((r) => (r.ok ? r.json() : { artifacts: [] }))
      .then((data: { artifacts: LavishArtifactTab[] }) => setArtifacts(data.artifacts || []))
      .catch(() => {});
  }, [projectId]);

  // Workers and servers appear without any action on this page, so poll for new tabs.
  useEffect(() => {
    refreshDelegations();
    refreshServers();
    refreshArtifacts();
    const timer = setInterval(() => {
      refreshDelegations();
      refreshServers();
      refreshArtifacts();
    }, 8000);
    return () => clearInterval(timer);
  }, [refreshDelegations, refreshServers, refreshArtifacts]);

  // Opening a worker's tab clears its "needs attention" flag. A worktree can
  // have older, closed-out delegations too; the newest one owns the tab.
  useEffect(() => {
    const open = [...delegations].reverse().find((d) => d.worktreeId === activeTab);
    if (!open?.unread) return;
    fetch(`/api/projects/${projectId}/delegations/${open.id}/read`, { method: 'POST' })
      .then(() => refreshDelegations())
      .catch(() => {});
  }, [activeTab, delegations, projectId, refreshDelegations]);

  useEffect(() => { refresh(); }, [projectId]);

  // One worker per worktree. Re-delegating leaves the old, closed-out
  // delegation in place, and rendering both gave the worktree two tabs with the
  // same id — so clicking either displayed both panes stacked on top of each
  // other. Rows arrive oldest-first, so the last one wins.
  //
  // The newest row decides, and only then is `closed` applied: a retired
  // worktree must not be resurrected by an older delegation that never got
  // closed out. Keeping those tabs is what made this strip grow without bound.
  const workers = Array.from(
    delegations
      .reduce((byWorktree, d) => byWorktree.set(d.worktreeId, d), new Map<string, Delegation>())
      .values(),
  ).filter((d) => d.status !== 'closed');

  // Tabs are never closable: the lead is permanent, and a worker tab is the
  // only way back into that worker's session from here.
  const serverTabId = (s: ManagedServer) => `${SERVER_TAB_PREFIX}${s.id}`;
  const artifactTabId = (a: LavishArtifactTab) => `${ARTIFACT_TAB_PREFIX}${a.id}`;
  const runningServerCount = servers.filter((s) => s.status === 'running' || s.status === 'starting').length;
  const tabs = [
    { id: 'lead', label: 'Lead', status: null as string | null, unread: 0 },
    ...workers.map((d) => ({
      id: d.worktreeId,
      label: d.title,
      status: d.status,
      unread: d.unread,
    })),
    ...servers.map((s) => ({
      id: serverTabId(s),
      label: s.name,
      status: s.status,
      unread: 0,
    })),
    ...artifacts.map((a) => ({
      id: artifactTabId(a),
      label: a.name,
      status: a.status,
      unread: 0,
    })),
  ];

  const focusFirstServerTab = () => {
    const target = servers.find((s) => s.status === 'running' || s.status === 'starting') ?? servers[0];
    if (target) setActiveTab(serverTabId(target));
  };

  // The lead retires a merged worktree on its own, which takes its tab with it.
  // Leaving the selection pointing at a tab that no longer exists left the page
  // showing no pane at all, with every tab unselected.
  const workerIds = workers.map((d) => d.worktreeId).join(',');
  const serverTabIds = servers.map((s) => serverTabId(s)).join(',');
  const artifactTabIds = artifacts.map((a) => artifactTabId(a)).join(',');
  useEffect(() => {
    if (activeTab === 'lead') return;
    const valid = new Set(
      [...workerIds.split(','), ...serverTabIds.split(','), ...artifactTabIds.split(',')].filter(Boolean),
    );
    if (!valid.has(activeTab)) setActiveTab('lead');
  }, [activeTab, workerIds, serverTabIds, artifactTabIds]);

  return (
    <div
      className={`grid h-[calc(100vh-4rem)] grid-cols-1 gap-4 overflow-auto p-4 xl:min-h-0 xl:overflow-hidden ${
        sidePanelOpen ? 'xl:grid-cols-[minmax(0,1fr)_22rem]' : 'xl:grid-cols-[minmax(0,1fr)]'
      }`}
    >
      <div className="flex min-h-[32rem] flex-col xl:min-h-0">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">Project Lead</h2>
          <p className="text-sm text-muted-foreground">Project-scoped planning and coordination</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          aria-expanded={sidePanelOpen}
          aria-controls="lead-side-panel"
          data-testid="lead-side-panel-toggle"
          title={sidePanelOpen ? 'Hide memory, decisions and recent actions' : 'Show memory, decisions and recent actions'}
          onClick={() => setSidePanelOpen((open) => !open)}
        >
          {sidePanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          <span className="ml-1.5">{sidePanelOpen ? 'Hide details' : 'Details'}</span>
        </Button>
      </div>
      <div role="tablist" aria-label="Project Lead and workers" className="mb-2 flex flex-wrap items-center gap-1">
        {tabs.map((tab) => {
          const isWorker =
            tab.id !== 'lead' &&
            !tab.id.startsWith(SERVER_TAB_PREFIX) &&
            !tab.id.startsWith(ARTIFACT_TAB_PREFIX);
          const workerActive = isWorker && WORKER_ACTIVE_STATUSES.has(tab.status ?? '');
          return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`lead-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.status ? `${tab.label} · ${tab.status.replace(/_/g, ' ')}` : 'Project Lead conversation'}
            className={`flex max-w-[14rem] items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
              activeTab === tab.id
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            }`}
          >
            {tab.id === 'lead' ? (
              <Compass className="h-3.5 w-3.5 shrink-0" />
            ) : tab.id.startsWith(SERVER_TAB_PREFIX) ? (
              <Server className="h-3.5 w-3.5 shrink-0" />
            ) : tab.id.startsWith(ARTIFACT_TAB_PREFIX) ? (
              <FileCode className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Users className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{tab.label}</span>
            {isWorker ? (
              <span
                data-testid={`worker-status-${tab.id}`}
                data-active={workerActive ? 'true' : 'false'}
                title={workerActive ? 'Worker active' : 'Worker done'}
                className={`h-2 w-2 shrink-0 rounded-full ${
                  workerActive ? 'bg-green-500' : 'bg-muted-foreground/30'
                }`}
              />
            ) : null}
            {tab.unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
          </button>
          );
        })}
        {servers.length > 0 && (
          <button
            type="button"
            data-testid="lead-server-badge"
            onClick={focusFirstServerTab}
            title={`${runningServerCount} server${runningServerCount === 1 ? '' : 's'} running`}
            className={`ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
              runningServerCount > 0
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            }`}
          >
            <Server className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">{runningServerCount}</span>
            <span
              className={`h-2 w-2 rounded-full ${runningServerCount > 0 ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
            />
          </button>
        )}
      </div>
      {/* Every pane stays mounted so switching tabs never drops a live session. */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border">
        <div className="absolute inset-0" style={{ display: activeTab === 'lead' ? 'block' : 'none' }}>
          <AgentPane projectId={projectId} active={activeTab === 'lead'} sessionKind="project_lead" />
        </div>
        {workers.map((d) => (
          <div
            // Re-keyed on the session so replacing a worker rebuilds the pane
            // instead of leaving it connected to the previous worker's session.
            key={`${d.worktreeId}:${d.sessionId ?? 'none'}`}
            className="absolute inset-0"
            style={{ display: activeTab === d.worktreeId ? 'block' : 'none' }}
          >
            {/* Target the worker's own session explicitly. Resolving the pane by
                workspace alone picks whichever session in that directory was
                touched most recently, which is not necessarily this worker —
                and after a server restart it never is. */}
            <AgentPane
              projectId={projectId}
              worktreeId={d.worktreeId}
              sessionId={d.sessionId ?? undefined}
              active={activeTab === d.worktreeId}
            />
          </div>
        ))}
        {servers.map((s) => {
          const tabId = serverTabId(s);
          return (
            <div
              key={tabId}
              className="absolute inset-0"
              style={{ display: activeTab === tabId ? 'block' : 'none' }}
            >
              <AgentPane
                projectId={projectId}
                active={activeTab === tabId}
                sessionKind="server"
                serverId={s.id}
                serverName={s.name}
                serverCommand={s.command}
                serverStatus={s.status}
                onServerDeleted={() => {
                  setActiveTab('lead');
                  refreshServers();
                }}
              />
            </div>
          );
        })}
        {artifacts.map((a) => {
          const tabId = artifactTabId(a);
          return (
            <div
              key={tabId}
              className="absolute inset-0"
              style={{ display: activeTab === tabId ? 'block' : 'none' }}
            >
              <AgentPane
                projectId={projectId}
                active={activeTab === tabId}
                sessionKind="artifact"
                artifactId={a.id}
                artifactName={a.name}
                artifactSessionKey={a.sessionKey}
                artifactStatus={a.status}
                onArtifactDeleted={() => {
                  setActiveTab('lead');
                  refreshArtifacts();
                }}
              />
            </div>
          );
        })}
      </div>
      </div>
      {sidePanelOpen && (
      <div
        id="lead-side-panel"
        data-testid="lead-side-panel"
        className="space-y-4 xl:min-h-0 xl:overflow-y-auto xl:pr-1"
      >
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Project memory</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => void refreshMemory()} disabled={refreshingMemory}>
              {refreshingMemory ? 'Refreshing…' : 'Refresh'}
            </Button>
          </CardHeader>
          <CardContent>
            {memory ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Bootstrapped {memory.source === 'manual-refresh' ? '(refreshed' : '(auto'}{memory.updatedAt ? ` ${memory.updatedAt})` : ')'}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{memory.summary}</pre>
              </details>
            ) : (
              <p className="text-sm text-muted-foreground">No memory bootstrapped yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="text-base">Todo list</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {/* The same list the project page shows, and the same one the lead
                edits with its todo tools — so the plan the lead is working to
                is visible here rather than buried in the transcript. */}
            <div className="flex h-80 flex-col overflow-hidden" data-testid="lead-todos">
              <ProjectTodoPanel projectId={projectId} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Decision threads</CardTitle>
            <Button size="sm" variant="ghost" onClick={refresh}>Refresh</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {threads.length === 0 ? <p className="text-sm text-muted-foreground">No handoffs recorded.</p> : threads.map((thread) => {
              const isOpen = openThreadId === thread.id;
              const unresolved = !['resolved', 'confirmed', 'closed'].includes(thread.status);
              return (
                <div key={thread.id} id={`thread-${thread.id}`} className="rounded border p-2 text-sm">
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 text-left"
                    aria-expanded={isOpen}
                    data-testid={`thread-toggle-${thread.id}`}
                    onClick={() => setOpenThreadId(isOpen ? null : thread.id)}
                  >
                    <ChevronRight className={`mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{thread.title || thread.question}</span>
                      <span className="block text-xs text-muted-foreground">
                        {thread.status} · updated {new Date(thread.updated_at).toLocaleString()}
                      </span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-2 space-y-2 border-t pt-2 text-xs">
                      <ThreadField label="Context" value={thread.question} />
                      <ThreadField label="Decision" value={thread.decision} />
                      <ThreadField label="Rationale" value={thread.rationale} />
                      <ThreadField label="Alternatives considered" value={thread.alternatives_considered} />
                      <ThreadField label="User verdict" value={thread.user_verdict} />
                      <ThreadField label="Follow-up actions" value={thread.follow_up_actions} />
                      <div className="text-muted-foreground">Opened {new Date(thread.created_at).toLocaleString()}</div>
                      <Button
                        size="sm"
                        variant={unresolved ? 'default' : 'ghost'}
                        disabled={resolvingId === thread.id}
                        data-testid={`thread-resolve-${thread.id}`}
                        onClick={() => void resolveThread(thread.id, unresolved ? 'resolved' : 'open')}
                      >
                        {resolvingId === thread.id ? 'Saving…' : unresolved ? 'Mark resolved' : 'Reopen'}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Recent actions</CardTitle>
            {audit.length > 0 && <span className="text-xs text-muted-foreground">{audit.length}</span>}
          </CardHeader>
          <CardContent className="space-y-2">
            {audit.length === 0 ? <p className="text-sm text-muted-foreground">No Project Lead actions yet.</p> : audit.map((entry) => {
              const linkedThread = entry.subject_id ? threads.find((t) => t.id === entry.subject_id) : undefined;
              return (
                <div key={entry.id} className="border-b pb-2 text-xs last:border-0">
                  <div className="font-medium">{entry.action} <span className="text-muted-foreground">({entry.risk_level || 'low'})</span></div>
                  {entry.reasoning && <div className="line-clamp-3 break-words text-muted-foreground" title={entry.reasoning}>{entry.reasoning}</div>}
                  {linkedThread && (
                    <button
                      type="button"
                      className="mt-1 text-primary underline-offset-2 hover:underline"
                      data-testid={`audit-thread-link-${entry.id}`}
                      onClick={() => {
                        setOpenThreadId(linkedThread.id);
                        document.getElementById(`thread-${linkedThread.id}`)?.scrollIntoView({ block: 'nearest' });
                      }}
                    >
                      View decision thread
                    </button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  );
}

function ThreadField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <div className="font-medium">{label}</div>
      <div className="whitespace-pre-wrap break-words text-muted-foreground">{value}</div>
    </div>
  );
}
