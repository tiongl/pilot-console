import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Clock, Hash } from 'lucide-react';
import type { CliSession } from '@/types';

interface Props {
  sessions: CliSession[];
}

export default function SessionList({ sessions }: Props) {
  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No sessions yet. Start a chat to create one.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {sessions.map((s) => (
        <Card key={s.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-mono">{s.id.slice(0, 8)}…</CardTitle>
              <Badge variant={s.endedAt ? 'secondary' : 'default'}>
                {s.endedAt ? 'Ended' : 'Active'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground flex flex-col gap-1">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> Started: {new Date(s.startedAt).toLocaleString()}
            </span>
            {s.endedAt && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" /> Ended: {new Date(s.endedAt).toLocaleString()}
              </span>
            )}
            {s.copilotSessionId && (
              <span className="flex items-center gap-1">
                <Hash className="h-3 w-3" /> Copilot ID: {s.copilotSessionId.slice(0, 12)}…
              </span>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
