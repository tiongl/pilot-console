'use client';

import { useEffect, useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  worktreeId: string;
  branch: string;
  issueNumber: number | null;
}

/**
 * Pushes the worktree branch and opens a pull request via the server `gh`
 * identity. When the worktree is linked to an issue, the body is prefilled with
 * `Closes #<n>` so merging the PR resolves the issue.
 */
export function CreatePullRequestDialog({ open, onOpenChange, projectId, worktreeId, branch, issueNumber }: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ number: number; url: string } | null>(null);

  useEffect(() => {
    if (open) {
      setTitle(issueNumber ? `Fix #${issueNumber}` : '');
      setBody(issueNumber ? `Closes #${issueNumber}` : '');
      setDraft(false);
      setError('');
      setCreated(null);
    }
  }, [open, issueNumber]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/github/pulls/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, title, body, draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to create PR (${res.status})`);
      setCreated(data as { number: number; url: string });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Pull Request</DialogTitle>
        </DialogHeader>
        {created ? (
          <div className="space-y-4">
            <p className="text-sm">
              Pull request <strong>#{created.number || ''}</strong> created from branch{' '}
              <code className="rounded bg-muted px-1">{branch}</code>.
            </p>
            <a
              href={created.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-4 w-4" />
              View on GitHub
            </a>
            <div className="flex justify-end">
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Pushes <code className="rounded bg-muted px-1">{branch}</code> and opens a PR
              {issueNumber ? <> for issue #{issueNumber}</> : null}.
            </p>
            <div className="space-y-2">
              <Label htmlFor="pr-title">Title</Label>
              <Input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pr-body">Description</Label>
              <Textarea id="pr-body" value={body} onChange={(e) => setBody(e.target.value)} rows={6} className="font-mono text-sm" />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="pr-draft"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="pr-draft" className="text-sm font-normal">Create as draft</Label>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !title.trim()}>
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Create PR
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
