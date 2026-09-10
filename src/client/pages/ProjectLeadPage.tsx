import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import AgentPane from '../components/terminal/AgentPane';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';

interface AuditEntry { id: string; action: string; reasoning: string | null; risk_level: string | null; created_at: string; }
interface DecisionThread { id: string; title: string | null; question: string; status: string; decision: string | null; }
interface ProjectMemory { summary: string; source: string | null; updatedAt: string | null; }

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

  const refreshMemory = async () => {
    setRefreshingMemory(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/refresh`, { method: 'POST' });
      if (response.ok) setMemory(await response.json());
    } finally {
      setRefreshingMemory(false);
    }
  };

  useEffect(() => { refresh(); }, [projectId]);

  return (
    <div className="grid h-[calc(100vh-4rem)] grid-cols-1 gap-4 overflow-auto p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-h-[32rem] flex-col">
      <div className="mb-3">
        <h2 className="text-xl font-semibold">Project Lead</h2>
        <p className="text-sm text-muted-foreground">Project-scoped planning and coordination</p>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        <AgentPane projectId={projectId} active sessionKind="project_lead" />
      </div>
      </div>
      <div className="space-y-4">
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
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Decision threads</CardTitle>
            <Button size="sm" variant="ghost" onClick={refresh}>Refresh</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {threads.length === 0 ? <p className="text-sm text-muted-foreground">No open handoffs.</p> : threads.map((thread) => (
              <div key={thread.id} className="rounded border p-2 text-sm">
                <div className="font-medium">{thread.title || thread.question}</div>
                <div className="text-xs text-muted-foreground">{thread.status}{thread.decision ? ` · ${thread.decision}` : ''}</div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Recent actions</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {audit.length === 0 ? <p className="text-sm text-muted-foreground">No Project Lead actions yet.</p> : audit.map((entry) => (
              <div key={entry.id} className="border-b pb-2 text-xs last:border-0">
                <div className="font-medium">{entry.action} <span className="text-muted-foreground">({entry.risk_level || 'low'})</span></div>
                {entry.reasoning && <div className="text-muted-foreground">{entry.reasoning}</div>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
