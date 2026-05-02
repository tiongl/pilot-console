import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate as useRouterNavigate } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '../components/ui/dialog';
import {
  Pencil, Zap, FileText, Eye, Trash2, RefreshCw,
  CheckCircle, XCircle, X, Loader2, Clock, AlertTriangle,
  ChevronLeft, ChevronRight, Square, Play, Terminal,
  Minus, Plus, WrapText, Sun, Moon, Mail, MailOpen,
  ArrowUp, ArrowDown, ArrowUpDown, Maximize2, Minimize2,
  Settings,
} from 'lucide-react';
import { useAutomation } from '../lib/automation-context';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import ScheduleInput from '../components/schedule/ScheduleInput';

const PAGE_SIZE = 50;

/** Format a date string as relative time (e.g. "2 min ago", "yesterday") */
function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 2) return '1 hr ago';
  if (diffHr < 24) return `${diffHr} hr ago`;

  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'today';
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  return date.toLocaleDateString();
}

interface RunSummary {
  id: string;
  scheduleId: string;
  scheduleName: string;
  status: string;
  triggeredBy: string;
  startedAt: string | null;
  completedAt: string | null;
  rendererType: string | null;
  exitCode: number | null;
  wasTruncated: boolean;
  error: string | null;
  read: boolean;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'running':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-destructive" />;
    case 'timed_out':
      return <AlertTriangle className="h-4 w-4 text-orange-500" />;
    case 'pending':
      return <Clock className="h-4 w-4 text-muted-foreground" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

/** Dialog showing report file content (markdown or plaintext) */
function FileViewDialog({ runId, runName, rendererType, open, onClose, fileUrl }: {
  runId: string;
  runName: string;
  rendererType: string | null;
  open: boolean;
  onClose: () => void;
  fileUrl?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(13);
  const [wordWrap, setWordWrap] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!open || !runId) return;
    setLoading(true);
    setError(null);
    setContent(null);
    fetch(fileUrl || `/api/admin/runs/${runId}/file`)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(text => setContent(text))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, runId]);

  const isMarkdown = rendererType === 'markdown';
  const isHtml = rendererType === 'html';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent showCloseButton={false} className={maximized ? '!max-w-none !w-screen !h-screen !rounded-none flex flex-col' : '!max-w-[85vw] max-h-[90vh] flex flex-col'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {runName}
            {rendererType && <Badge variant="outline">{rendererType}</Badge>}
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setMaximized(m => !m)}
                title={maximized ? 'Restore' : 'Maximize'}
              >
                {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
              <DialogClose render={
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Close" />
              }>
                <X className="h-4 w-4" />
              </DialogClose>
            </div>
          </DialogTitle>
        </DialogHeader>

        {/* Font controls */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground border-b pb-2">
          <div className="flex items-center gap-1">
            <span>Font:</span>
            <Button variant="outline" size="sm" className="h-6 w-6 p-0" onClick={() => setFontSize(s => Math.max(8, s - 1))}>
              <Minus className="h-3 w-3" />
            </Button>
            <span className="w-6 text-center">{fontSize}</span>
            <Button variant="outline" size="sm" className="h-6 w-6 p-0" onClick={() => setFontSize(s => Math.min(24, s + 1))}>
              <Plus className="h-3 w-3" />
            </Button>
          </div>
          {!isHtml && (
            <Button
              variant={wordWrap ? 'default' : 'outline'}
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => setWordWrap(w => !w)}
            >
              <WrapText className="h-3 w-3 mr-1" />
              Wrap
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <Sun className="h-3 w-3 mr-1" /> : <Moon className="h-3 w-3 mr-1" />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>

        {loading && <p className="text-muted-foreground py-8 text-center">Loading file...</p>}
        {error && <p className="text-destructive py-4 text-center">Failed to load file: {error}</p>}
        {content !== null && (
          isHtml ? (
            <iframe
              srcDoc={content}
              className={`rounded-lg overflow-auto w-full border ${maximized ? 'flex-1' : 'max-h-[70vh]'} ${theme === 'dark' ? 'bg-[#1e1e1e]' : 'bg-white'}`}
              style={{ minHeight: 300, fontSize }}
              sandbox="allow-same-origin"
              title="HTML output"
            />
          ) : isMarkdown ? (
            <div
              className={`prose prose-sm max-w-none overflow-auto rounded-lg p-4
                ${maximized ? 'flex-1' : 'max-h-[70vh]'}
                [&_table]:border-collapse [&_th]:border [&_th]:px-3 [&_th]:py-1.5
                [&_td]:border [&_td]:px-3 [&_td]:py-1.5
                ${theme === 'dark'
                  ? 'dark prose-invert bg-[#1e1e1e] text-[#d4d4d4] [&_th]:border-[#444] [&_td]:border-[#444] [&_th]:bg-[#2d2d2d]'
                  : 'bg-white text-[#1e1e1e] [&_th]:border-[#ddd] [&_td]:border-[#ddd] [&_th]:bg-[#f5f5f5]'
                }`}
              style={{ fontSize }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          ) : (
            <pre
              className={`rounded-lg p-4 overflow-auto font-mono
                ${maximized ? 'flex-1' : 'max-h-[70vh]'}
                ${theme === 'dark' ? 'bg-[#1e1e1e] text-[#d4d4d4]' : 'bg-white text-[#1e1e1e] border'}`}
              style={{ fontSize, whiteSpace: wordWrap ? 'pre-wrap' : 'pre', wordBreak: wordWrap ? 'break-word' : 'normal' }}
            >
              {content}
            </pre>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Dialog showing live terminal output for a running report */
function TerminalDialog({ runId, runName, open, onClose, onKill }: {
  runId: string;
  runName: string;
  open: boolean;
  onClose: () => void;
  onKill: () => void;
}) {
  const [output, setOutput] = useState('');
  const [isRunning, setIsRunning] = useState(true);
  const termRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open || !runId) return;
    setOutput('');
    setIsRunning(true);

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/runs/${runId}/live`);
        if (!res.ok) return;
        const data = await res.json();
        setOutput(data.output || '');
        setIsRunning(data.running);
        if (!data.running) clearInterval(poll);
      } catch {}
    }, 1000);

    return () => clearInterval(poll);
  }, [open, runId]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="!max-w-[85vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            {runName}
            {isRunning ? (
              <Badge variant="default" className="bg-blue-500">Running</Badge>
            ) : (
              <Badge variant="secondary">Finished</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <pre
          ref={termRef}
          className="bg-black text-green-400 rounded-lg p-4 overflow-auto text-xs font-mono whitespace-pre-wrap flex-1 min-h-[300px] max-h-[65vh]"
        >
          {output || (isRunning ? 'Waiting for output...' : 'No output.')}
        </pre>

        {isRunning && (
          <div className="flex justify-end">
            <Button variant="destructive" size="sm" onClick={onKill}>
              <Square className="h-4 w-4 mr-1" />
              Stop
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type SortKey = 'scheduleName' | 'status' | 'completedAt' | 'triggeredBy';
type SortDir = 'asc' | 'desc';

// Core component — works with or without router context
export function AutomationHistoryCore({ scheduleFilter, onNavigate }: { scheduleFilter?: string; onNavigate?: (path: string) => void }) {
  const nav = onNavigate || (() => {});
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('completedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [termDialogOpen, setTermDialogOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', prompt: '', cronExpression: '0 9 * * *', rendererType: 'plaintext', cwd: '', maxRuntimeMs: 300000, maxRunsRetained: 50 });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [renderers, setRenderers] = useState<string[]>([]);
  const { markSeen } = useAutomation();

  // Get the schedule name for display when filtered
  const filteredScheduleName = scheduleFilter
    ? runs.find(r => r.scheduleId === scheduleFilter)?.scheduleName
    : undefined;

  const fetchRuns = useCallback(async (p = page) => {
    try {
      let url = `/api/admin/runs?limit=${PAGE_SIZE}&offset=${p * PAGE_SIZE}`;
      if (scheduleFilter) url += `&scheduleId=${encodeURIComponent(scheduleFilter)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const runsList: RunSummary[] = data.runs || [];
        setRuns(runsList);
        setTotal(data.total ?? 0);

        if (p === 0) {
          const latestCompleted = runsList
            .filter(r => r.completedAt)
            .map(r => r.completedAt!)
            .sort()
            .pop();
          if (latestCompleted) {
            markSeen(latestCompleted);
          }
        }
      }
    } catch {}
    setLoading(false);
  }, [markSeen, page, scheduleFilter]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Reset page when schedule filter changes
  useEffect(() => {
    setPage(0);
    setSelectedIds(new Set());
  }, [scheduleFilter]);

  // Listen for report-ready WebSocket events to auto-refresh
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?notify=true`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'report-ready') {
            fetchRuns();
          }
        } catch {}
      };
      ws.onclose = () => { reconnectTimer = setTimeout(connect, 5000); };
      ws.onerror = () => { ws?.close(); };
    }

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [fetchRuns]);

  // --- Edit schedule inline ---
  const openEditDialog = async () => {
    if (!scheduleFilter) return;
    setEditError('');
    try {
      const [schedRes, rendRes] = await Promise.all([
        fetch(`/api/admin/schedules/${scheduleFilter}`),
        fetch('/api/admin/renderers'),
      ]);
      if (schedRes.ok) {
        const s = await schedRes.json();
        setEditForm({
          name: s.name,
          prompt: s.prompt,
          cronExpression: s.cronExpression,
          rendererType: s.rendererType,
          cwd: s.cwd || '',
          maxRuntimeMs: s.maxRuntimeMs,
          maxRunsRetained: s.maxRunsRetained,
        });
      }
      if (rendRes.ok) {
        const data = await rendRes.json();
        setRenderers(data.renderers || []);
      }
      setEditDialogOpen(true);
    } catch {}
  };

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleFilter) return;
    setEditSaving(true);
    setEditError('');
    try {
      const res = await fetch(`/api/admin/schedules/${scheduleFilter}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editForm, cwd: editForm.cwd || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEditDialogOpen(false);
      fetchRuns();
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setEditSaving(false);
    }
  };

  // --- Selection ---
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === runs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(runs.map(r => r.id)));
    }
  };

  // --- Actions ---
  const openFile = async (run: RunSummary) => {
    setSelectedRun(run);
    setFileDialogOpen(true);
    // Mark as read when viewing output
    if (!run.read) {
      try {
        await fetch('/api/admin/runs/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [run.id] }),
        });
        setRuns(prev => prev.map(r => r.id === run.id ? { ...r, read: true } : r));
      } catch {}
    }
  };

  const openTerminal = (run: RunSummary) => {
    setSelectedRun(run);
    setTermDialogOpen(true);
  };

  const openLog = (run: RunSummary) => {
    setSelectedRun(run);
    setLogDialogOpen(true);
  };

  const closeDialogs = () => {
    setFileDialogOpen(false);
    setLogDialogOpen(false);
    setTermDialogOpen(false);
    setSelectedRun(null);
    fetchRuns();
  };

  const deleteRun = async (runId: string) => {
    try {
      const res = await fetch(`/api/admin/runs/${runId}`, { method: 'DELETE' });
      if (res.ok) {
        setRuns(prev => prev.filter(r => r.id !== runId));
        setTotal(prev => prev - 1);
        setSelectedIds(prev => { const n = new Set(prev); n.delete(runId); return n; });
      }
    } catch {}
  };

  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} run(s)?`)) return;
    try {
      const res = await fetch('/api/admin/runs/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      if (res.ok) {
        setSelectedIds(new Set());
        fetchRuns();
      }
    } catch {}
  };

  const deleteAll = async () => {
    if (total === 0) return;
    if (!confirm(`Delete all ${total} run(s)? This cannot be undone.`)) return;
    // Select all IDs on current page + fetch remaining
    const allIds = runs.map(r => r.id);
    // For simplicity, delete page by page
    try {
      const res = await fetch('/api/admin/runs/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: allIds, all: true }),
      });
      if (res.ok) {
        setSelectedIds(new Set());
        setPage(0);
        fetchRuns(0);
      }
    } catch {}
  };

  const killRun = async (runId: string) => {
    try {
      await fetch(`/api/admin/runs/${runId}/kill`, { method: 'POST' });
      fetchRuns();
    } catch {}
  };

  const retriggerRun = async (run: RunSummary) => {
    try {
      await fetch(`/api/admin/schedules/${run.scheduleId}/run`, { method: 'POST' });
      fetchRuns();
    } catch {}
  };

  const markSelectedRead = async () => {
    const ids = [...selectedIds];
    try {
      await fetch('/api/admin/runs/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      setRuns(prev => prev.map(r => ids.includes(r.id) ? { ...r, read: true } : r));
      setSelectedIds(new Set());
    } catch {}
  };

  const markSelectedUnread = async () => {
    const ids = [...selectedIds];
    try {
      await fetch('/api/admin/runs/mark-unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      setRuns(prev => prev.map(r => ids.includes(r.id) ? { ...r, read: false } : r));
      setSelectedIds(new Set());
    } catch {}
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const allSelected = runs.length > 0 && selectedIds.size === runs.length;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'completedAt' ? 'desc' : 'asc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    return sortDir === 'asc'
      ? <ArrowUp className="h-3 w-3 ml-1" />
      : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  const sortedRuns = [...runs].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortKey) {
      case 'scheduleName':
        return dir * a.scheduleName.localeCompare(b.scheduleName);
      case 'status':
        return dir * a.status.localeCompare(b.status);
      case 'completedAt': {
        const ta = a.completedAt || a.startedAt || '';
        const tb = b.completedAt || b.startedAt || '';
        return dir * ta.localeCompare(tb);
      }
      case 'triggeredBy':
        return dir * a.triggeredBy.localeCompare(b.triggeredBy);
      default:
        return 0;
    }
  });

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap className="h-6 w-6" />
          <h2 className="text-2xl font-bold">{filteredScheduleName || 'Automation'}</h2>
          {scheduleFilter && (
            <button onClick={openEditDialog} title="Edit this automation">
              <Pencil className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={markSelectedRead}>
                <MailOpen className="h-4 w-4 mr-1" />
                Mark Read
              </Button>
              <Button variant="outline" size="sm" onClick={markSelectedUnread}>
                <Mail className="h-4 w-4 mr-1" />
                Mark Unread
              </Button>
              <Button variant="destructive" size="sm" onClick={deleteSelected}>
                <Trash2 className="h-4 w-4 mr-1" />
                Delete ({selectedIds.size})
              </Button>
            </>
          )}
          {total > 0 && selectedIds.size === 0 && (
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={deleteAll}>
              <Trash2 className="h-4 w-4 mr-1" />
              Delete All
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => fetchRuns()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => nav('/automation/config')}>
              <Settings className="h-4 w-4 mr-1" />
              Configure
            </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : runs.length === 0 && page === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Zap className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="text-lg">No automation runs yet</p>
          <p className="text-sm mt-1">
            <button onClick={() => nav('/automation/config')} className="text-primary hover:underline">Configure automations</button> to get started.
          </p>
        </div>
      ) : (
        <>
          <div className="border rounded-lg">
            <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-background">
                  <tr className="bg-muted/50 border-b">
                  <th className="px-3 py-2 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-muted-foreground"
                    />
                  </th>
                  <th className="text-left px-4 py-2 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort('scheduleName')}>
                    <span className="flex items-center">Automation<SortIcon col="scheduleName" /></span>
                  </th>
                  <th className="text-left px-4 py-2 font-medium">Output</th>
                  <th className="text-left px-4 py-2 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort('status')}>
                    <span className="flex items-center">Status<SortIcon col="status" /></span>
                  </th>
                  <th className="text-left px-4 py-2 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort('completedAt')}>
                    <span className="flex items-center">Completed<SortIcon col="completedAt" /></span>
                  </th>
                  <th className="text-left px-4 py-2 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort('triggeredBy')}>
                    <span className="flex items-center">Trigger<SortIcon col="triggeredBy" /></span>
                  </th>
                  <th className="text-left px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRuns.map(run => (
                  <tr
                    key={run.id}
                    className={`border-b hover:bg-muted/30 transition-colors ${selectedIds.has(run.id) ? 'bg-muted/20' : ''} ${!run.read ? 'font-semibold' : 'text-muted-foreground'}`}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(run.id)}
                        onChange={() => toggleSelect(run.id)}
                        className="rounded border-muted-foreground"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {!run.read && <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />}
                        <span className={run.read ? 'text-foreground' : ''}>{run.scheduleName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {run.status === 'running' && (
                          <Button variant="ghost" size="sm" onClick={() => openTerminal(run)} title="Live output">
                            <Terminal className="h-4 w-4" />
                          </Button>
                        )}
                        {(run.status === 'completed' || run.status === 'failed' || run.status === 'timed_out') && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => openFile(run)} title="View output">
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openLog(run)} title="View log (prompt + PTY output)">
                              <FileText className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5" title={run.error || run.status}>
                        <StatusIcon status={run.status} />
                        <span className="capitalize">{run.status}</span>
                        {run.exitCode !== null && run.exitCode !== 0 && (
                          <span className="text-xs text-destructive">(exit {run.exitCode})</span>
                        )}
                      </div>
                      {run.error && (
                        <p className="text-xs text-destructive truncate max-w-[200px] mt-0.5" title={run.error}>{run.error}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" title={run.completedAt ? new Date(run.completedAt).toLocaleString() : ''}>
                      {run.completedAt ? relativeTime(run.completedAt) : run.status === 'running' ? '—' : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{run.triggeredBy}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {run.status === 'running' && (
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => killRun(run.id)} title="Stop">
                            <Square className="h-4 w-4" />
                          </Button>
                        )}
                        {(run.status === 'completed' || run.status === 'failed' || run.status === 'timed_out') && (
                          <Button variant="ghost" size="sm" onClick={() => retriggerRun(run)} title="Re-run">
                            <Play className="h-4 w-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => deleteRun(run.id)} title="Delete">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total} runs
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage(p => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedRun && fileDialogOpen && (
        <FileViewDialog
          runId={selectedRun.id}
          runName={selectedRun.scheduleName}
          rendererType={selectedRun.rendererType}
          open={fileDialogOpen}
          onClose={closeDialogs}
        />
      )}

      {selectedRun && logDialogOpen && (
        <FileViewDialog
          runId={selectedRun.id}
          runName={`${selectedRun.scheduleName} — Log`}
          rendererType="plaintext"
          open={logDialogOpen}
          onClose={closeDialogs}
          fileUrl={`/api/admin/runs/${selectedRun.id}/log`}
        />
      )}

      {selectedRun && termDialogOpen && (
        <TerminalDialog
          runId={selectedRun.id}
          runName={selectedRun.scheduleName}
          open={termDialogOpen}
          onClose={closeDialogs}
          onKill={() => killRun(selectedRun.id)}
        />
      )}

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Schedule</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={editForm.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-prompt">Prompt</Label>
              <Textarea id="edit-prompt" value={editForm.prompt} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditForm(f => ({ ...f, prompt: e.target.value }))} rows={4} required />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <ScheduleInput value={editForm.cronExpression} onChange={(cron) => setEditForm(f => ({ ...f, cronExpression: cron }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-renderer">Renderer</Label>
                <select id="edit-renderer" value={editForm.rendererType} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditForm(f => ({ ...f, rendererType: e.target.value }))} className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm">
                  {renderers.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cwd">Working Directory (optional)</Label>
              <Input id="edit-cwd" value={editForm.cwd} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm(f => ({ ...f, cwd: e.target.value }))} placeholder="Leave empty for server default" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-timeout">Timeout (ms)</Label>
                <Input id="edit-timeout" type="number" value={editForm.maxRuntimeMs} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm(f => ({ ...f, maxRuntimeMs: parseInt(e.target.value) || 300000 }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-retention">Max Runs Retained</Label>
                <Input id="edit-retention" type="number" value={editForm.maxRunsRetained} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm(f => ({ ...f, maxRunsRetained: parseInt(e.target.value) || 50 }))} />
              </div>
            </div>
            {editError && <p className="text-sm text-destructive">{editError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={editSaving}>{editSaving ? 'Saving…' : 'Save'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Route wrapper — reads schedule filter from URL and provides navigation
export default function AutomationHistoryPage() {
  const [searchParams] = useSearchParams();
  const navigate = useRouterNavigate();
  const scheduleFilter = searchParams.get('schedule') || undefined;
  return <AutomationHistoryCore scheduleFilter={scheduleFilter} onNavigate={navigate} />;
}
