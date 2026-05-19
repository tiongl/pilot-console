'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Clock, MessageSquare, User, Bot, X, Search } from 'lucide-react';

interface CopilotSession {
  id: string;
  summary: string | null;
  cwd: string | null;
  createdAt: string;
  updatedAt: string | null;
  turnCount: number;
  durationMs: number | null;
  activeMs: number | null;
  userMsgChars: number;
  assistantMsgChars: number;
}

interface CopilotTurn {
  turn_index: number;
  user_message: string;
  assistant_response: string;
  timestamp: string;
}

interface SessionDetail {
  id: string;
  summary: string | null;
  cwd: string | null;
  createdAt: string;
  turns: CopilotTurn[];
}

interface Props {
  projectId: string;
}

export default function SessionHistory({ projectId }: Props) {
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const fetchIdRef = useRef(0);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchSessions = useCallback(async (searchTerm: string) => {
    const id = ++fetchIdRef.current;
    if (searchTerm) setSearching(true);
    try {
      const params = searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : '';
      const res = await fetch(`/api/projects/${projectId}/sessions${params}`);
      if (res.ok && fetchIdRef.current === id) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } finally {
      if (fetchIdRef.current === id) {
        setLoading(false);
        setSearching(false);
      }
    }
  }, [projectId]);

  useEffect(() => { fetchSessions(debouncedSearch); }, [fetchSessions, debouncedSearch]);

  const viewSession = async (sessionId: string) => {
    if (detail?.id === sessionId) {
      setDetail(null);
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${sessionId}/transcript`);
      if (res.ok) {
        const data = await res.json();
        setDetail(data);
      }
    } catch {
      setDetail(null);
    }
  };

  const formatDate = (d: string | null | undefined) => {
    if (!d) return 'Unknown date';
    const date = new Date(d);
    if (isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (ms: number | null) => {
    if (ms == null || ms < 0) return null;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };

  const formatChars = (n: number) => {
    if (n < 1000) return `${n}`;
    if (n < 100_000) return `${(n / 1000).toFixed(1)}K`;
    return `${Math.round(n / 1000)}K`;
  };

  const filtered = hideEmpty ? sessions.filter(s => s.turnCount > 0) : sessions;
  const hiddenCount = sessions.length - (hideEmpty ? sessions.filter(s => s.turnCount > 0) : sessions).length;

  if (loading) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Session History</h3>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Search */}
        <div className="px-3 py-1.5 border-b">
          <div className="flex items-center gap-1.5 bg-muted/50 rounded px-2 py-1">
            <Search className="h-3 w-3 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search sessions & content…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="bg-transparent text-xs outline-none w-full placeholder:text-muted-foreground"
            />
            {searching && (
              <span className="text-muted-foreground text-xs shrink-0">…</span>
            )}
            {search && !searching && (
              <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Hide empty toggle */}
        {sessions.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none px-3 py-1.5 border-b">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={e => setHideEmpty(e.target.checked)}
              className="rounded border-border"
            />
            Hide empty{hiddenCount > 0 && ` (${hiddenCount})`}
          </label>
        )}

        {/* Session list */}
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            {sessions.length > 0 ? (search ? 'No matching sessions.' : 'All sessions are empty.') : 'No past sessions'}
          </p>
        ) : (
          <div className="divide-y">
            {filtered.map(s => (
              <div
                key={s.id}
                className="px-3 py-2 hover:bg-accent/50 cursor-pointer"
                onClick={() => viewSession(s.id)}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">
                      {s.summary || formatDate(s.createdAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(s.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground shrink-0">
                    {formatDuration(s.durationMs) && (
                      <span className="flex items-center gap-0.5 text-xs" title="Total duration">
                        <Clock className="h-3 w-3" />
                        {formatDuration(s.durationMs)}
                      </span>
                    )}
                    {formatDuration(s.activeMs) && (
                      <span className="flex items-center gap-0.5 text-xs text-green-500" title="Estimated active time (excludes idle gaps >5min)">
                        ⚡{formatDuration(s.activeMs)}
                      </span>
                    )}
                    <span className="flex items-center gap-0.5 text-xs" title="Turns">
                      <MessageSquare className="h-3 w-3" />
                      {s.turnCount}
                    </span>
                  </div>
                </div>
                {s.turnCount > 0 && (
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <span title="User input">↑ {formatChars(s.userMsgChars)}</span>
                    <span title="Assistant output">↓ {formatChars(s.assistantMsgChars)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Session detail dialog */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDetail(null)}>
          <div
            className="bg-background border rounded-lg shadow-lg w-full max-w-3xl max-h-[80vh] flex flex-col mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
              <div>
                <h3 className="text-lg font-semibold">{detail.summary || 'Session Detail'}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{formatDate(detail.createdAt)} · {detail.turns.length} turns</p>
              </div>
              <button
                onClick={() => setDetail(null)}
                className="p-1 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
              {detail.turns.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No conversation turns</p>
              ) : (
                detail.turns.map((turn) => (
                  <div key={turn.turn_index} className="space-y-2">
                    <div className="flex items-start gap-2">
                      <div className="flex items-center gap-1 mt-1 shrink-0">
                        <User className="h-4 w-4 text-blue-400" />
                        <span className="text-xs font-medium text-blue-400">tiongl@</span>
                      </div>
                      <pre className="text-sm whitespace-pre-wrap break-words flex-1 bg-accent/30 rounded p-3">{turn.user_message}</pre>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="flex items-center gap-1 mt-1 shrink-0">
                        <Bot className="h-4 w-4 text-green-400" />
                        <span className="text-xs font-medium text-green-400">copilot</span>
                      </div>
                      <pre className="text-sm whitespace-pre-wrap break-words flex-1 text-muted-foreground p-3">{turn.assistant_response}</pre>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
