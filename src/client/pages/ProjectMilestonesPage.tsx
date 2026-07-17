import { useParams } from 'react-router';
import { Target } from 'lucide-react';
import { useGitHubResource } from '../hooks/useGitHubResource';
import { GitHubViewShell } from '../components/github/GitHubViewShell';
import type { GitHubMilestone } from '@/types';

export default function ProjectMilestonesPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data, loading, loaded, error, refresh } = useGitHubResource<{ milestones: GitHubMilestone[] }>(
    id,
    '/milestones',
  );
  const milestones = data?.milestones ?? [];

  return (
    <GitHubViewShell title="Milestones" icon={<Target className="h-4 w-4" />} loading={loading} loaded={loaded} error={error} onRefresh={refresh}>
      {milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground">No milestones.</p>
      ) : (
        <div className="space-y-3">
          {milestones.map((m) => {
            const total = m.openIssues + m.closedIssues;
            const pct = total === 0 ? 0 : Math.round((m.closedIssues / total) * 100);
            return (
              <div key={m.number} className="rounded-lg border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a href={m.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      {m.title}
                    </a>
                    {m.description && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{m.description}</p>}
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${m.state === 'open' ? 'bg-green-500/15 text-green-600' : 'bg-muted text-muted-foreground'}`}>
                    {m.state}
                  </span>
                </div>
                <div className="mt-3">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{pct}% complete</span>
                    <span>
                      {m.closedIssues} closed / {m.openIssues} open
                      {m.dueOn && <> · due {new Date(m.dueOn).toLocaleDateString()}</>}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </GitHubViewShell>
  );
}
