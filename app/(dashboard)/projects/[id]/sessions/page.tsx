import { getDb } from '@/lib/app-db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default async function ProjectSessionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const sessions = getDb()
    .prepare(`
      SELECT cs.id, cs.copilot_session_id, cs.started_at, cs.ended_at
      FROM cli_sessions cs
      WHERE cs.project_id = ?
      ORDER BY cs.started_at DESC
      LIMIT 50
    `)
    .all(id) as Array<{
      id: string;
      copilot_session_id: string | null;
      started_at: string;
      ended_at: string | null;
    }>;

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
                  <Badge variant={s.ended_at ? 'secondary' : 'default'}>
                    {s.ended_at ? 'Ended' : 'Active'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="py-2 px-4 text-xs text-muted-foreground space-y-1">
                <p>Started: {new Date(s.started_at + 'Z').toLocaleString()}</p>
                {s.ended_at && <p>Ended: {new Date(s.ended_at + 'Z').toLocaleString()}</p>}
                {s.copilot_session_id && (
                  <p className="font-mono truncate">Copilot: {s.copilot_session_id}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
