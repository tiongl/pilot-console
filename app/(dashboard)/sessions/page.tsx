import { auth } from '@/lib/auth';
import { listSessionsForUser } from '@/lib/session-store';
import SessionList from '@/components/sessions/SessionList';

export default async function SessionsPage() {
  const session = await auth();
  const sessions = session?.user?.id ? listSessionsForUser(session.user.id) : [];

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h2 className="text-2xl font-bold">Session History</h2>
        <p className="text-muted-foreground mt-1">Your past Copilot CLI sessions</p>
      </div>
      <SessionList sessions={sessions} />
    </div>
  );
}
