'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, repoPath, description: description || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to create project');
      router.push(`/projects/${data.id}/chat`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center flex-1 p-8">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>New Project</CardTitle>
          <CardDescription>
            Point to a local repo to start using Copilot CLI with it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Project Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-awesome-project"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="repoPath">Repository Path</Label>
              <Input
                id="repoPath"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="C:\Users\you\repos\my-project"
                className="font-mono text-sm"
                required
              />
              <p className="text-xs text-muted-foreground">
                Absolute path to the local git repository. Copilot CLI will run from this directory.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of the project"
                rows={2}
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="flex gap-3">
              <Button type="submit" disabled={loading || !name || !repoPath}>
                {loading ? 'Creating…' : 'Create Project'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
