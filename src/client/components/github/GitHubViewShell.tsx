import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { GitHubError } from '../../hooks/useGitHubResource';
import { GitHubScopeGate } from './GitHubScopeGate';

interface Props {
  title: string;
  icon: React.ReactNode;
  loading: boolean;
  loaded: boolean;
  error: GitHubError | null;
  onRefresh: () => void;
  /** Extra controls rendered in the header (filters, project picker, etc.). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Common chrome for the GitHub project views: a sticky header with title +
 * refresh, skeletons on first load, an actionable gate for known error codes,
 * and a generic error fallback otherwise.
 */
export function GitHubViewShell({ title, icon, loading, loaded, error, onRefresh, actions, children }: Props) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRefresh} disabled={loading} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {error ? (
          <ErrorArea error={error} onRefresh={onRefresh} />
        ) : !loaded ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function ErrorArea({ error, onRefresh }: { error: GitHubError; onRefresh: () => void }) {
  const gate = GitHubScopeGate({ error });
  if (gate) return gate;
  return (
    <div className="mx-auto mt-8 max-w-lg rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm">
      <p className="font-semibold text-destructive">Failed to load from GitHub</p>
      <p className="mt-1 text-muted-foreground">{error.message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRefresh}>
        Try again
      </Button>
    </div>
  );
}
