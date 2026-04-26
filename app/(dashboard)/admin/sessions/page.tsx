import { listAllSessions } from '@/lib/session-store';
import { getAllSessions } from '@/lib/cli-bridge';
import ActiveSessionsTable from '@/components/admin/ActiveSessionsTable';

export default function AdminSessionsPage() {
  const dbSessions = listAllSessions();
  const activePids = getAllSessions().map((s) => s.sessionId);
  const sessions = dbSessions.map((s) => ({ ...s, isActive: activePids.includes(s.id) }));

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h2 className="text-2xl font-bold">All Sessions</h2>
        <p className="text-muted-foreground mt-1">Monitor and terminate any user&apos;s CLI session</p>
      </div>
      <ActiveSessionsTable sessions={sessions} />
    </div>
  );
}
