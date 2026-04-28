'use client';

import { useEffect, useState, useCallback } from 'react';
import { Clock, MessageSquare, User, Bot, X } from 'lucide-react';

interface CopilotSession {
  id: string;
  summary: string | null;
  cwd: string | null;
  createdAt: string;
  turnCount: number;
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

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

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

  if (loading) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Session History</h3>
      </div>

      {detail ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
            <span className="text-xs text-muted-foreground truncate">
              {detail.summary || formatDate(detail.createdAt)}
            </span>
            <button onClick={() => setDetail(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {detail.turns.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No conversation turns</p>
            ) : (
              detail.turns.map((turn) => (
                <div key={turn.turn_index} className="space-y-2">
                  <div className="flex items-start gap-2">
                    <User className="h-3.5 w-3.5 text-blue-400 mt-0.5 shrink-0" />
                    <pre className="text-xs whitespace-pre-wrap break-words flex-1 text-foreground">{turn.user_message}</pre>
                  </div>
                  <div className="flex items-start gap-2 pl-1">
                    <Bot className="h-3.5 w-3.5 text-green-400 mt-0.5 shrink-0" />
                    <pre className="text-xs whitespace-pre-wrap break-words flex-1 text-muted-foreground">{turn.assistant_response}</pre>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No past sessions</p>
          ) : (
            <div className="divide-y">
              {sessions.map(s => (
                <div
                  key={s.id}
                  className="px-3 py-2 hover:bg-accent/50 cursor-pointer flex items-center gap-2"
                  onClick={() => viewSession(s.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">
                      {s.summary || formatDate(s.createdAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(s.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground shrink-0">
                    <MessageSquare className="h-3 w-3" />
                    <span className="text-xs">{s.turnCount}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
