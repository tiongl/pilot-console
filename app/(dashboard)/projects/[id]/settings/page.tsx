'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Project {
  id: string;
  name: string;
  repoPath: string;
  description: string | null;
}

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${params.id}`)
      .then((r) => r.json())
      .then((p: Project) => {
        setProject(p);
        setName(p.name);
        setRepoPath(p.repoPath);
        setDescription(p.description ?? '');
      });
  }, [params.id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, repoPath, description: description || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    await fetch(`/api/projects/${params.id}`, { method: 'DELETE' });
    router.push('/');
    router.refresh();
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

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>Permanently delete this project and all its data.</CardDescription>
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
