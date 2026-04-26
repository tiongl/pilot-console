import { useAuth } from '../lib/auth-context';

export default function SessionsPage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h2 className="text-2xl font-bold">Session History</h2>
        <p className="text-muted-foreground mt-1">Your past Copilot CLI sessions</p>
      </div>
      <p className="text-sm text-muted-foreground">
        Select a project from the sidebar to view its session history.
      </p>
    </div>
  );
}
