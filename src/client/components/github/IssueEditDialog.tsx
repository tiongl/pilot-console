import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import type { GitHubBoardColumn, GitHubBoardItem, GitHubIssueDetail } from '@/types';

const NO_STATUS = '__no_status__';

/**
 * A popup for editing the issue behind a board/table card: its title, body
 * (markdown description) and Status column. Title/body persist via the issue
 * PATCH route; Status persists via the board item-move route. Non-issue cards
 * (PRs / draft issues) can only have their Status changed.
 */
export function IssueEditDialog({
  open,
  onOpenChange,
  consoleProjectId,
  ghProjectId,
  item,
  columns,
  groupFieldId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consoleProjectId: string;
  ghProjectId: string;
  item: GitHubBoardItem | null;
  columns: GitHubBoardColumn[];
  groupFieldId: string | null;
  onSaved: () => void;
}) {
  const base = `/api/projects/${encodeURIComponent(consoleProjectId)}/github`;
  const isIssue = item?.contentType === 'Issue' && item.number != null;

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string>(NO_STATUS);

  // Load the current title/body (body isn't on the board item) whenever opened.
  useEffect(() => {
    if (!open || !item) return;
    setTitle(item.title);
    setStatus(columnIdForStatus(columns, item.status));
    setBody('');
    if (!isIssue) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${base}/issues/${item.number}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Load failed (${r.status})`))))
      .then((b: { issue: GitHubIssueDetail }) => {
        if (cancelled) return;
        setTitle(b.issue.title);
        setBody(b.issue.body ?? '');
      })
      .catch((err) => {
        if (!cancelled) toast.error((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, item]);

  if (!item) return null;

  const targetOptionId = status === NO_STATUS ? null : status;
  const targetName = status === NO_STATUS ? null : columns.find((c) => c.id === status)?.name ?? null;
  const statusChanged = targetName !== (item.status ?? null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (isIssue && !trimmed) {
      toast.error('Title is required');
      return;
    }
    setSaving(true);
    try {
      if (isIssue) {
        const patch: { title?: string; body?: string } = { body };
        if (trimmed !== item.title) patch.title = trimmed;
        const res = await fetch(`${base}/issues/${item.number}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Save failed (${res.status})`);
      }
      if (statusChanged && groupFieldId) {
        const res = await fetch(`${base}/board/item/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ghProjectId, itemId: item.itemId, fieldId: groupFieldId, optionId: targetOptionId }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Status update failed (${res.status})`);
      }
      toast.success('Issue updated');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Edit {item.contentType === 'PullRequest' ? 'pull request' : 'issue'}
            {item.number != null && <span className="ml-1 text-muted-foreground">#{item.number}</span>}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="issue-title">Title</Label>
            <Input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!isIssue || loading}
              required={isIssue}
            />
            {!isIssue && (
              <p className="text-[11px] text-muted-foreground">
                Only the Status of {item.contentType === 'PullRequest' ? 'pull requests' : 'draft items'} can be edited here.
              </p>
            )}
          </div>

          {isIssue && (
            <div className="space-y-2">
              <Label htmlFor="issue-body">Description</Label>
              {loading ? (
                <Skeleton className="h-28 w-full" />
              ) : (
                <Textarea
                  id="issue-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={8}
                  className="font-mono text-xs"
                  placeholder="Markdown description…"
                />
              )}
            </div>
          )}

          {groupFieldId && columns.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="issue-status">Status</Label>
              <select
                id="issue-status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value={NO_STATUS}>No Status</option>
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || loading}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function columnIdForStatus(columns: GitHubBoardColumn[], status: string | null): string {
  if (!status) return NO_STATUS;
  return columns.find((c) => c.name === status)?.id ?? NO_STATUS;
}
