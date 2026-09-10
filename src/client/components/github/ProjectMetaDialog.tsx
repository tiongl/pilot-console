import { useEffect, useState } from 'react';
import { Loader2, Lock, Globe } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { GitHubProjectOverview } from '@/types';

/** Edit a Projects V2 project's title, description and visibility. */
export function ProjectMetaDialog({
  open,
  onOpenChange,
  consoleProjectId,
  ghProjectId,
  overview,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consoleProjectId: string;
  ghProjectId: string;
  overview: GitHubProjectOverview;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(overview.title);
  const [description, setDescription] = useState(overview.shortDescription ?? '');
  const [isPublic, setIsPublic] = useState(overview.public);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(overview.title);
      setDescription(overview.shortDescription ?? '');
      setIsPublic(overview.public);
    }
  }, [open, overview]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(consoleProjectId)}/github/project-meta?ghProjectId=${encodeURIComponent(ghProjectId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, shortDescription: description, public: isPublic }),
        },
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Save failed (${res.status})`);
      toast.success('Project updated');
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="proj-title">Title</Label>
            <Input id="proj-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proj-desc">Short description</Label>
            <Textarea id="proj-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2">
            <Label>Visibility</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsPublic(false)}
                className={`flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm ${!isPublic ? 'border-primary bg-primary/5' : 'text-muted-foreground'}`}
              >
                <Lock className="h-4 w-4" /> Private
              </button>
              <button
                type="button"
                onClick={() => setIsPublic(true)}
                className={`flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm ${isPublic ? 'border-primary bg-primary/5' : 'text-muted-foreground'}`}
              >
                <Globe className="h-4 w-4" /> Public
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Private boards are visible only to you and collaborators you grant access; public boards are read-only to
              anyone.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
