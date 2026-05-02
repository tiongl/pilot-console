import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { ArrowLeft, Eye, Play, Square, Terminal, ChevronDown, ChevronUp, Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { stripAnsi } from '@/lib/strip-ansi';

interface RunSummary {
  id: string;
  scheduleId: string;
  status: string;
  triggeredBy: string;
  startedAt: string | null;
  completedAt: string | null;
  rendererType: string | null;
  exitCode: number | null;
  wasTruncated: boolean;
  error: string | null;
}

interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cronExpression: string;
  rendererType: string;
  enabled: boolean;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed': return 'default';
    case 'running': return 'secondary';
    case 'failed': return 'destructive';
    case 'timed_out': return 'destructive';
    default: return 'outline';
  }
}

function elapsed(start: string | null): string {
  if (!start) return '';
  return formatDuration(new Date(start).getTime(), Date.now());
}

function formatDuration(startMs: number, endMs: number): string {
  const s = Math.floor((endMs - startMs) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function ScheduleRunsPage() {
  const { id } = useParams<{ id: string }>();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [triggeringRun, setTriggeringRun] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [liveOutput, setLiveOutput] = useState('');
  const [killingRun, setKillingRun] = useState<string | null>(null);
  const [fullscreenRun, setFullscreenRun] = useState<string | null>(null);
  const [fullscreenOutput, setFullscreenOutput] = useState('');
  const outputRef = useRef<HTMLPreElement>(null);
  const fullscreenOutputRef = useRef<HTMLPreElement>(null);

  const hasRunning = runs.some(r => r.status === 'running');

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      const [schedRes, runsRes] = await Promise.all([
        fetch(`/api/admin/schedules/${id}`),
        fetch(`/api/admin/schedules/${id}/runs?limit=50`),
      ]);
      if (schedRes.ok) setSchedule(await schedRes.json());
      if (runsRes.ok) {
        const data = await runsRes.json();
        setRuns(data.runs || []);
      }
    } catch {}
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh when a run is in "running" state
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(fetchData, 4000);
    return () => clearInterval(interval);
  }, [hasRunning, fetchData]);

  // Fetch live output for expanded running run
  useEffect(() => {
    if (!expandedRun) { setLiveOutput(''); return; }
    const run = runs.find(r => r.id === expandedRun);
    if (!run || run.status !== 'running') return;

    const fetchLive = async () => {
      try {
        const res = await fetch(`/api/admin/runs/${expandedRun}/live`);
        if (res.ok) {
          const data = await res.json();
          setLiveOutput(data.output || '');
          // Auto-scroll
          if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
          }
        }
      } catch {}
    };
    fetchLive();
    const interval = setInterval(fetchLive, 2000);
    return () => clearInterval(interval);
  }, [expandedRun, runs]);

  // Fetch live output for fullscreen dialog
  useEffect(() => {
    if (!fullscreenRun) { setFullscreenOutput(''); return; }
    const run = runs.find(r => r.id === fullscreenRun);
    if (!run || run.status !== 'running') return;

    const fetchLive = async () => {
      try {
        const res = await fetch(`/api/admin/runs/${fullscreenRun}/live`);
        if (res.ok) {
          const data = await res.json();
          setFullscreenOutput(data.output || '');
          if (fullscreenOutputRef.current) {
            fullscreenOutputRef.current.scrollTop = fullscreenOutputRef.current.scrollHeight;
          }
        }
      } catch {}
    };
    fetchLive();
    const interval = setInterval(fetchLive, 1500);
    return () => clearInterval(interval);
  }, [fullscreenRun, runs]);

  const handleTrigger= async () => {
    if (!id) return;
    setTriggeringRun(true);
    try {
      await fetch(`/api/admin/schedules/${id}/run`, { method: 'POST' });
      setTimeout(fetchData, 2000);
    } catch {}
    setTriggeringRun(false);
  };

  const handleKill = async (runId: string) => {
    setKillingRun(runId);
    try {
      await fetch(`/api/admin/runs/${runId}/kill`, { method: 'POST' });
      setTimeout(fetchData, 1000);
    } catch {}
    setKillingRun(null);
  };

  if (!schedule) {
    return <div className="p-8 text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center gap-4">
        <Link to="/automation/config" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h2 className="text-2xl font-bold">{schedule.name}</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Cron: <code className="bg-muted px-1 rounded">{schedule.cronExpression}</code>
            {' · '}Renderer: {schedule.rendererType}
          </p>
        </div>
        <Button onClick={handleTrigger} disabled={triggeringRun} variant="outline">
          <Play className="h-4 w-4 mr-2" />
          Run Now
        </Button>
      </div>

      {runs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No runs yet. Trigger a manual run or wait for the schedule.</p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Started</th>
                <th className="px-4 py-2 text-left font-medium">Duration</th>
                <th className="px-4 py-2 text-left font-medium">Triggered By</th>
                <th className="px-4 py-2 text-left font-medium">Exit Code</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <>
                  <tr key={run.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                      {run.wasTruncated && (
                        <Badge variant="outline" className="ml-1 text-[10px]">truncated</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {run.status === 'running'
                        ? elapsed(run.startedAt)
                        : run.startedAt && run.completedAt
                          ? formatDuration(new Date(run.startedAt!).getTime(), new Date(run.completedAt!).getTime())
                          : '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{run.triggeredBy}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {run.exitCode ?? (run.error ? <span className="text-destructive text-xs">{run.error}</span> : '—')}
                    </td>
                    <td className="px-4 py-2 text-right space-x-1">
                      {run.status === 'running' && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                            title="View live output"
                          >
                            {expandedRun === run.id ? <ChevronUp className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setFullscreenRun(run.id)}
                            title="Full terminal view"
                          >
                            <Maximize2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleKill(run.id)}
                            disabled={killingRun === run.id}
                            title="Kill this run"
                            className="text-destructive hover:text-destructive"
                          >
                            <Square className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {run.status === 'completed' && (
                        <Link to={`/admin/reports/${run.id}`}>
                          <Button variant="ghost" size="sm" title="View report">
                            <Eye className="h-4 w-4" />
                          </Button>
                        </Link>
                      )}
                    </td>
                  </tr>
                  {expandedRun === run.id && run.status === 'running' && (
                    <tr key={`${run.id}-output`} className="border-t bg-muted/20">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                          <Terminal className="h-3 w-3" /> Live Output
                          <span className="ml-auto animate-pulse text-green-500">● running</span>
                        </div>
                        <pre
                          ref={outputRef}
                          className="bg-background border rounded p-3 text-xs font-mono max-h-96 overflow-auto whitespace-pre-wrap"
                        >
                          {liveOutput ? stripAnsi(liveOutput) : 'Waiting for output...'}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Full terminal dialog for running session */}
      <Dialog open={!!fullscreenRun} onOpenChange={(open) => { if (!open) setFullscreenRun(null); }}>
        <DialogContent className="!max-w-[90vw] w-full h-[80vh] flex flex-col">
          <DialogHeader className="flex-none">
            <DialogTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              Live Session Output
              {fullscreenRun && runs.find(r => r.id === fullscreenRun)?.status === 'running' && (
                <span className="animate-pulse text-green-500 text-sm font-normal ml-2">● running</span>
              )}
              {fullscreenRun && runs.find(r => r.id === fullscreenRun)?.startedAt && (
                <span className="text-sm font-normal text-muted-foreground ml-auto">
                  Elapsed: {elapsed(runs.find(r => r.id === fullscreenRun)!.startedAt)}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <pre
            ref={fullscreenOutputRef}
            className="flex-1 bg-zinc-950 text-green-400 rounded-lg p-4 text-sm font-mono overflow-auto whitespace-pre-wrap"
          >
            {fullscreenOutput ? stripAnsi(fullscreenOutput) : 'Waiting for output...'}
          </pre>
          <div className="flex-none flex justify-end gap-2 pt-2">
            {fullscreenRun && runs.find(r => r.id === fullscreenRun)?.status === 'running' && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => { handleKill(fullscreenRun!); setFullscreenRun(null); }}
              >
                <Square className="h-4 w-4 mr-2" />
                Kill Session
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setFullscreenRun(null)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
