import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { CircleDot, MessageSquare, Play, Loader2 } from 'lucide-react';
import { useGitHubResource } from '../hooks/useGitHubResource';
import { useStartIssueSession } from '../hooks/useStartIssueSession';
import { GitHubViewShell } from '../components/github/GitHubViewShell';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GitHubIssue } from '@/types';

type StateFilter = 'all' | 'open' | 'closed';

export default function ProjectIssuesPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data, loading, loaded, error, refresh } = useGitHubResource<{ issues: GitHubIssue[] }>(id, '/issues');
  const issues = data?.issues ?? [];
  const { start, startingIssue } = useStartIssueSession(id);

  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [labelFilter, setLabelFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [query, setQuery] = useState('');

  const labels = useMemo(() => uniqueSorted(issues.flatMap((i) => i.labels.map((l) => l.name))), [issues]);
  const assignees = useMemo(() => uniqueSorted(issues.flatMap((i) => i.assignees.map((a) => a.login))), [issues]);

  const filtered = issues.filter((i) => {
    if (stateFilter !== 'all' && i.state !== stateFilter) return false;
    if (labelFilter !== 'all' && !i.labels.some((l) => l.name === labelFilter)) return false;
    if (assigneeFilter !== 'all' && !i.assignees.some((a) => a.login === assigneeFilter)) return false;
    if (query && !`#${i.number} ${i.title}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <GitHubViewShell
      title="Issues"
      icon={<CircleDot className="h-4 w-4" />}
      loading={loading}
      loaded={loaded}
      error={error}
      onRefresh={refresh}
      actions={
        <div className="flex items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" className="h-8 w-36" />
          <FilterSelect value={stateFilter} onChange={(v) => setStateFilter(v as StateFilter)} options={['open', 'closed', 'all']} />
          {labels.length > 0 && <FilterSelect value={labelFilter} onChange={setLabelFilter} options={['all', ...labels]} placeholder="Label" />}
          {assignees.length > 0 && <FilterSelect value={assigneeFilter} onChange={setAssigneeFilter} options={['all', ...assignees]} placeholder="Assignee" />}
        </div>
      }
    >
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matching issues.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {filtered.map((i) => (
            <div key={i.number} className="flex items-start gap-3 p-3">
              <CircleDot className={`mt-0.5 h-4 w-4 shrink-0 ${i.state === 'open' ? 'text-green-600' : 'text-purple-500'}`} />
              <div className="min-w-0 flex-1">
                <Link to={`/projects/${id}/view/issues/${i.number}`} className="font-medium hover:underline">
                  {i.title}
                </Link>
                <span className="ml-1 text-xs text-muted-foreground">#{i.number}</span>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {i.labels.map((l) => (
                    <LabelChip key={l.name} name={l.name} color={l.color} />
                  ))}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {i.author && <>opened by {i.author.login} · </>}
                  {new Date(i.createdAt).toLocaleDateString()}
                  {i.milestone && <> · {i.milestone}</>}
                  {i.assignees.length > 0 && <> · @{i.assignees.map((a) => a.login).join(', @')}</>}
                </div>
              </div>
              {i.comments > 0 && (
                <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {i.comments}
                </div>
              )}
              {i.state === 'open' && (
                <button
                  type="button"
                  onClick={() => start(i.number)}
                  disabled={startingIssue === i.number}
                  className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                  title="Work locally: create a worktree branch and launch a Copilot session seeded from this issue"
                >
                  {startingIssue === i.number ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Work locally
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </GitHubViewShell>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger className="h-8 w-auto min-w-[90px] text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="text-xs">
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  const c = color && /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : '#888888';
  return (
    <span
      className="rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
      style={{ borderColor: c, color: c }}
    >
      {name}
    </span>
  );
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
