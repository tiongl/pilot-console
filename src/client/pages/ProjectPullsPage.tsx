import { useState } from 'react';
import { useParams } from 'react-router';
import { GitPullRequest, GitMerge } from 'lucide-react';
import { useGitHubResource } from '../hooks/useGitHubResource';
import { GitHubViewShell } from '../components/github/GitHubViewShell';
import { LabelChip } from './ProjectIssuesPage';
import type { GitHubPullRequest, GitHubBoardItem } from '@/types';

type Tab = 'all' | 'by-task';

interface PullsByTask {
  title: string;
  groups: Array<{ status: string; items: GitHubBoardItem[] }>;
}

export default function ProjectPullsPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('all');

  const all = useGitHubResource<{ pulls: GitHubPullRequest[] }>(id, '/pulls', { enabled: tab === 'all' });
  const byTask = useGitHubResource<PullsByTask>(id, '/pulls-by-task', { enabled: tab === 'by-task' });

  const active = tab === 'all' ? all : byTask;

  return (
    <GitHubViewShell
      title="Pull Requests"
      icon={<GitPullRequest className="h-4 w-4" />}
      loading={active.loading}
      loaded={active.loaded}
      error={active.error}
      onRefresh={active.refresh}
      actions={
        <div className="flex overflow-hidden rounded-md border text-xs">
          <TabBtn active={tab === 'all'} onClick={() => setTab('all')}>
            All
          </TabBtn>
          <TabBtn active={tab === 'by-task'} onClick={() => setTab('by-task')}>
            By task
          </TabBtn>
        </div>
      }
    >
      {tab === 'all' ? (
        <PullList pulls={all.data?.pulls ?? []} />
      ) : (
        <ByTask data={byTask.data} />
      )}
    </GitHubViewShell>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 transition-colors ${active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
    >
      {children}
    </button>
  );
}

function PullIcon({ state, isDraft }: { state: GitHubPullRequest['state']; isDraft: boolean }) {
  if (state === 'merged') return <GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" />;
  return (
    <GitPullRequest
      className={`mt-0.5 h-4 w-4 shrink-0 ${state === 'closed' ? 'text-red-500' : isDraft ? 'text-muted-foreground' : 'text-green-600'}`}
    />
  );
}

function PullRow({ pr }: { pr: GitHubPullRequest }) {
  return (
    <div className="flex items-start gap-3 p-3">
      <PullIcon state={pr.state} isDraft={pr.isDraft} />
      <div className="min-w-0 flex-1">
        <a href={pr.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
          {pr.title}
        </a>
        <span className="ml-1 text-xs text-muted-foreground">#{pr.number}</span>
        {pr.isDraft && <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">draft</span>}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {pr.labels.map((l) => (
            <LabelChip key={l.name} name={l.name} color={l.color} />
          ))}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {pr.author && <>by {pr.author.login} · </>}
          {new Date(pr.createdAt).toLocaleDateString()}
          {pr.milestone && <> · {pr.milestone}</>}
        </div>
      </div>
    </div>
  );
}

function PullList({ pulls }: { pulls: GitHubPullRequest[] }) {
  if (pulls.length === 0) return <p className="text-sm text-muted-foreground">No pull requests.</p>;
  return (
    <div className="divide-y rounded-lg border">
      {pulls.map((pr) => (
        <PullRow key={pr.number} pr={pr} />
      ))}
    </div>
  );
}

function ByTask({ data }: { data: PullsByTask | null }) {
  if (!data || data.groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No board tasks have linked pull requests.</p>;
  }
  return (
    <div className="space-y-5">
      {data.groups.map((group) => (
        <div key={group.status}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.status}</h3>
          <div className="space-y-3">
            {group.items.map((item) => (
              <div key={item.itemId} className="rounded-lg border">
                <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {item.title}
                    </a>
                  ) : (
                    item.title
                  )}
                  {item.number != null && <span className="ml-1 text-xs text-muted-foreground">#{item.number}</span>}
                </div>
                <div className="divide-y">
                  {item.linkedPullRequests.map((pr) => (
                    <PullRow key={pr.number} pr={pr} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
