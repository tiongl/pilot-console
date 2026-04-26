import { useEffect, useState } from 'react';
import ActiveSessionsTable from '../../../components/admin/ActiveSessionsTable';

interface SessionInfo {
  id: string;
  userId: string;
  projectId: string | null;
  startedAt: string;
  endedAt: string | null;
  isActive: boolean;
}

export default function AdminSessionsPage() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const [dbRes, activeRes] = await Promise.all([
          fetch('/api/admin/sessions'),
          fetch('/api/sessions/active'),
        ]);
        const dbData = await dbRes.json();
        const activeData = await activeRes.json();
        const activeIds = new Set((activeData.sessions || []).map((s: any) => s.sessionId));
        const merged = (Array.isArray(dbData) ? dbData : []).map((s: any) => ({
          ...s,
          isActive: activeIds.has(s.id),
        }));
        setSessions(merged);
      } catch {}
    }
    load();
  }, []);

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
