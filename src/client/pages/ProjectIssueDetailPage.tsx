import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, CircleDot, ExternalLink, GitBranch, Loader2, Pencil, Play, X } from 'lucide-react';
import { useGitHubResource } from '../hooks/useGitHubResource';
import { GitHubScopeGate } from '../components/github/GitHubScopeGate';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { LabelChip } from './ProjectIssuesPage';
import type { GitHubIssueDetail } from '@/types';

export default function ProjectIssueDetailPage() {
  const { id = '', number = '' } = useParams<{ id: string; number: string }>();
  const navigate = useNavigate();
  const { data, loading, loaded, error, refresh } = useGitHubResource<{ issue: GitHubIssueDetail }>(
    id,
    `/issues/${number}`,
    { pollMs: 0 },
  );
  const issue = data?.issue ?? null;

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (issue) {
      setEditTitle(issue.title);
      setEditBody(issue.body);
    }
  }, [issue]);

  const base = `/projects/${id}/view`;

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${id}/github/issues/${number}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle, body: editBody }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
      toast.success('Issue updated');
      setEditing(false);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleStartWork() {
    setStarting(true);
    try {
      const res = await fetch(`/api/projects/${id}/github/issues/${number}/start-work`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed to start work (${res.status})`);
      toast.success(`Worktree created for issue #${number}`);
      navigate(`/projects/${id}/worktrees/${body.worktree.id}/chat`);
    } catch (err) {
      toast.error((err as Error).message);
      setStarting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <button
          onClick={() => navigate(`${base}/issues`)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Issues
        </button>
        <div className="flex items-center gap-2">
          {issue && !editing && (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
              <Button size="sm" onClick={handleStartWork} disabled={starting}>
                {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                Start work
              </Button>
            </>
          )}
          {editing && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !editTitle.trim()}>
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {error ? (
          GitHubScopeGate({ error }) ?? (
            <div className="mx-auto mt-8 max-w-lg rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm">
              <p className="font-semibold text-destructive">Failed to load issue</p>
              <p className="mt-1 text-muted-foreground">{error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={refresh}>
                Try again
              </Button>
            </div>
          )
        ) : !loaded ? (
          <div className="mx-auto max-w-3xl space-y-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : issue ? (
          <div className="mx-auto max-w-3xl">
            {editing ? (
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="text-lg font-semibold" />
            ) : (
              <div className="flex items-start gap-2">
                <CircleDot className={`mt-1 h-5 w-5 shrink-0 ${issue.state === 'open' ? 'text-green-600' : 'text-purple-500'}`} />
                <h1 className="text-lg font-semibold">
                  {issue.title} <span className="font-normal text-muted-foreground">#{issue.number}</span>
                </h1>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${issue.state === 'open' ? 'bg-green-600/15 text-green-700 dark:text-green-400' : 'bg-purple-500/15 text-purple-600 dark:text-purple-400'}`}>
                {issue.state}
              </span>
              {issue.author && <>opened by {issue.author.login}</>}
              <span>· {new Date(issue.createdAt).toLocaleDateString()}</span>
              {issue.milestone && <span>· {issue.milestone}</span>}
              {issue.assignees.length > 0 && <span>· @{issue.assignees.map((a) => a.login).join(', @')}</span>}
              <a href={issue.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 hover:text-foreground">
                <ExternalLink className="h-3.5 w-3.5" />
                GitHub
              </a>
            </div>

            {issue.labels.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {issue.labels.map((l) => (
                  <LabelChip key={l.name} name={l.name} color={l.color} />
                ))}
              </div>
            )}

            <div className="mt-4 border-t pt-4">
              {editing ? (
                <Textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={16}
                  className="font-mono text-sm"
                  placeholder="Describe the issue (markdown supported)…"
                />
              ) : issue.body.trim() ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.body}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm italic text-muted-foreground">No description provided.</p>
              )}
            </div>

            <div className="mt-6 flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              <GitBranch className="h-4 w-4 shrink-0" />
              <span>
                <strong className="text-foreground">Start work</strong> creates a dedicated worktree
                (branch <code>issue-{issue.number}</code>) and launches a Copilot session seeded with this issue.
              </span>
            </div>
          </div>
        ) : null}
        {loading && loaded && (
          <div className="pointer-events-none fixed bottom-4 right-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
