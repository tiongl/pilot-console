import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';

interface SessionInfo {
  id: string;
  copilotSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export default function ProjectSessionsPage() {
  const { id } = useParams<{ id: string }>();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/projects/${id}/sessions`)
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => {});
  }, [id]);

  return (
    <div className="p-6 space-y-4">
      <h3 className="text-lg font-semibold">Session History</h3>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions yet. Start a chat to create one.</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <Card key={s.id}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-mono">{s.id.slice(0, 8)}</CardTitle>
                  <Badge variant={s.endedAt ? 'secondary' : 'default'}>
                    {s.endedAt ? 'Ended' : 'Active'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="py-2 px-4 text-xs text-muted-foreground space-y-1">
                <p>Started: {new Date(s.startedAt + 'Z').toLocaleString()}</p>
                {s.endedAt && <p>Ended: {new Date(s.endedAt + 'Z').toLocaleString()}</p>}
                {s.copilotSessionId && (
                  <p className="font-mono truncate">Copilot: {s.copilotSessionId}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
