import { useEffect, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Bot } from 'lucide-react';

interface ActiveSession {
  projectId: string;
  sessionId: string;
}

export default function AgentsPage() {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);

  useEffect(() => {
    fetch('/api/sessions/active')
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h2 className="text-2xl font-bold">Agent Sessions</h2>
        <p className="text-muted-foreground mt-1">Active Copilot CLI processes</p>
      </div>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active agent sessions. Open a Chat to start one.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {sessions.map((s) => (
            <Card key={s.sessionId}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Bot className="h-4 w-4" />
                    Session {s.sessionId.slice(0, 8)}…
                  </CardTitle>
                  <Badge className="bg-green-500 text-white">Running</Badge>
                </div>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Project: {s.projectId.slice(0, 8)}…
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
