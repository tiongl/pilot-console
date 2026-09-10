import { useEffect, useState } from 'react';
import { KanbanSquare, Loader2, Plus, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GitHubProjectPicker } from './GitHubProjectPicker';
import { GitHubScopeGate } from './GitHubScopeGate';
import { toast } from 'sonner';
import type { GitHubError } from '../../hooks/useGitHubResource';

/**
 * Shown in a project view when the console project isn't linked to any GitHub
 * Projects V2 board. Lets the user either create a brand-new board (owned by the
 * repo owner and linked to the repo) or link an existing one. On success it
 * calls `onLinked` so the host view can reload.
 */
export function ProjectLinkPrompt({ projectId, onLinked }: { projectId: string; onLinked: () => void }) {
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<GitHubError | null>(null);

  const base = `/api/projects/${encodeURIComponent(projectId)}/github`;

  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p?.name && setTitle(String(p.name)))
      .catch(() => {});
  }, [projectId]);

  const createBoard = async () => {
    const t = title.trim();
    if (!t) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${base}/links/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({ message: body.error || `Create failed (${res.status})`, code: body.code ?? null });
        return;
      }
      toast.success('Project board created and linked');
      onLinked();
    } catch (err) {
      setError({ message: (err as Error).message, code: null });
    } finally {
      setCreating(false);
    }
  };

  const gate = error ? GitHubScopeGate({ error }) : null;

  return (
    <div className="mx-auto mt-8 max-w-lg rounded-lg border bg-card p-6 text-sm">
      <div className="mb-2 flex items-center gap-2 font-semibold">
        <KanbanSquare className="h-5 w-5 text-muted-foreground" />
        No GitHub Project linked
      </div>
      <p className="text-muted-foreground">
        This console project isn&rsquo;t linked to a GitHub Projects V2 board yet. Most teams keep a shared board and
        link it to each repo &mdash; pick an existing one, or create a new board if you don&rsquo;t have one.
      </p>

      <Button className="mt-5 w-full" onClick={() => setPickerOpen(true)}>
        <Link2 className="h-4 w-4" />
        Link an existing board
      </Button>

      <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or create a new one
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-board-title">New board name</Label>
        <div className="flex gap-2">
          <Input
            id="new-board-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createBoard();
            }}
            placeholder="e.g. My repo board"
          />
          <Button variant="outline" onClick={() => void createBoard()} disabled={creating || !title.trim()} className="shrink-0">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </Button>
        </div>
      </div>

      {gate && <div className="mt-4">{gate}</div>}
      {error && !gate && <p className="mt-4 text-xs text-destructive">{error.message}</p>}

      <Dialog
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) onLinked();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link a GitHub Project</DialogTitle>
          </DialogHeader>
          <GitHubProjectPicker projectId={projectId} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
