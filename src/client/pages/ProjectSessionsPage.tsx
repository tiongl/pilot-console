import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { MessageSquare, User, Bot } from 'lucide-react';

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

export default function ProjectSessionsPage() {
  const { id } = useParams<{ id: string }>();
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/projects/${id}/sessions`)
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => {});
  }, [id]);

  const viewSession = async (sessionId: string) => {
    if (detail?.id === sessionId) { setDetail(null); return; }
    try {
      const res = await fetch(`/api/sessions/${sessionId}/transcript`);
      if (res.ok) setDetail(await res.json());
    } catch { /* ignore */ }
  };

  const formatDate = (d: string | null | undefined) => {
    if (!d) return 'Unknown date';
    const date = new Date(d);
    if (isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleString();
  };

  if (detail) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{detail.summary || 'Session Detail'}</h3>
          <button onClick={() => setDetail(null)} className="text-sm text-muted-foreground hover:text-foreground">← Back</button>
        </div>
        <p className="text-xs text-muted-foreground">{formatDate(detail.createdAt)}</p>
        <div className="space-y-4">
          {detail.turns.map(turn => (
            <div key={turn.turn_index} className="space-y-2">
              <div className="flex items-start gap-2">
                <User className="h-4 w-4 text-blue-400 mt-1 shrink-0" />
                <pre className="text-sm whitespace-pre-wrap break-words flex-1 bg-accent/30 rounded p-3">{turn.user_message}</pre>
              </div>
              <div className="flex items-start gap-2">
                <Bot className="h-4 w-4 text-green-400 mt-1 shrink-0" />
                <pre className="text-sm whitespace-pre-wrap break-words flex-1 text-muted-foreground p-3">{turn.assistant_response}</pre>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <h3 className="text-lg font-semibold">Session History</h3>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions yet. Start a chat to create one.</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <Card key={s.id} className="cursor-pointer hover:bg-accent/30 transition-colors" onClick={() => viewSession(s.id)}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm truncate">
                    {s.summary || formatDate(s.createdAt)}
                  </CardTitle>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {s.turnCount}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="py-2 px-4 text-xs text-muted-foreground">
                <p>{formatDate(s.createdAt)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
