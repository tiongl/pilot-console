'use client';

import { useEffect, useState, useCallback } from 'react';
import { Clock, FileText, X } from 'lucide-react';

interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string | null;
  hasTranscript: number;
}

interface Props {
  projectId: string;
}

export default function SessionHistory({ projectId }: Props) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
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

  const viewTranscript = async (sessionId: string) => {
    if (selectedId === sessionId) {
      setSelectedId(null);
      setTranscript(null);
      return;
    }
    setSelectedId(sessionId);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/transcript`);
      if (res.ok) {
        const data = await res.json();
        setTranscript(data.transcript);
      } else {
        setTranscript(null);
      }
    } catch {
      setTranscript(null);
    }
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'Z');
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return 'active';
    const ms = new Date(end + 'Z').getTime() - new Date(start + 'Z').getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  if (loading) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Session History</h3>
      </div>

      {selectedId && transcript !== null ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
            <span className="text-xs text-muted-foreground truncate">Transcript</span>
            <button onClick={() => { setSelectedId(null); setTranscript(null); }} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <pre className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap bg-[#1e1e2e] text-[#cdd6f4]">
            {transcript}
          </pre>
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
                  onClick={() => s.hasTranscript && viewTranscript(s.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{formatDate(s.startedAt)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDuration(s.startedAt, s.endedAt)}
                    </p>
                  </div>
                  {s.hasTranscript ? (
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <span className="text-xs text-muted-foreground">no log</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
