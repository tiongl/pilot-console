import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

interface Project {
  id: string;
  name: string;
  repoPath: string;
  description: string | null;
}

interface AutonomySettings {
  mergeMode: 'advisory' | 'auto_queue' | 'full_auto';
  interventionMode: 'flag_only' | 'flag_nudge' | 'flag_nudge_cancel';
  dnd: number;
}

export default function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [autonomy, setAutonomy] = useState<AutonomySettings>({
    mergeMode: 'advisory',
    interventionMode: 'flag_only',
    dnd: 0,
  });
  const [autonomySaving, setAutonomySaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetch(`/api/projects/${id}`).then((r) => r.json()),
      fetch(`/api/projects/${id}/autonomy`).then((r) => r.json()),
    ]).then(([p, autonomyData]: [Project, { settings: AutonomySettings }]) => {
        setProject(p);
        setName(p.name);
        setRepoPath(p.repoPath);
        setDescription(p.description ?? '');
        setAutonomy(autonomyData.settings);
      });
  }, [id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, repoPath, description: description || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveAutonomy = async (e: React.FormEvent) => {
    e.preventDefault();
    setAutonomySaving(true);
    try {
      await fetch(`/api/projects/${id}/autonomy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...autonomy, dnd: Boolean(autonomy.dnd) }),
      });
    } finally {
      setAutonomySaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this project from Pilot Console? Your git repository will not be affected.')) return;
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    navigate('/');
  };

  if (!project) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6 max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Project Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repoPath">Repository Path</Label>
              <Input
                id="repoPath"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                className="font-mono text-sm"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chief of Staff autonomy</CardTitle>
          <CardDescription>Conservative defaults are recommended. Full auto can create and auto-merge pull requests.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveAutonomy} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="merge-mode">Merge mode</Label>
              <select
                id="merge-mode"
                className="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={autonomy.mergeMode}
                onChange={(e) => setAutonomy((current) => ({ ...current, mergeMode: e.target.value as AutonomySettings['mergeMode'] }))}
              >
                <option value="advisory">Advisory - require approval</option>
                <option value="auto_queue">Auto-queue approved requests</option>
                <option value="full_auto">Full auto - request GitHub auto-merge</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="intervention-mode">Intervention mode</Label>
              <select
                id="intervention-mode"
                className="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={autonomy.interventionMode}
                onChange={(e) => setAutonomy((current) => ({ ...current, interventionMode: e.target.value as AutonomySettings['interventionMode'] }))}
              >
                <option value="flag_only">Flag only</option>
                <option value="flag_nudge">Allow soft nudges</option>
                <option value="flag_nudge_cancel">Allow nudges and cancellation</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(autonomy.dnd)}
                onChange={(e) => setAutonomy((current) => ({ ...current, dnd: e.target.checked ? 1 : 0 }))}
              />
              Quiet notifications for this project
            </label>
            <Button type="submit" disabled={autonomySaving}>{autonomySaving ? 'Saving…' : 'Save autonomy settings'}</Button>
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>Remove this project from Pilot Console. Your git repository on disk will not be deleted or modified.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={handleDelete}>
            Delete Project
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
