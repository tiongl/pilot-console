import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth-context';
import { Button } from '../../../components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { FolderOpen, Plus } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  repoPath: string;
  description: string | null;
}

export default function HomePage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => setProjects(data.projects || []))
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-8 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold">Welcome back, {user?.displayName ?? 'there'}</h2>
          <p className="text-muted-foreground mt-1">GitHub Copilot CLI — Web Interface</p>
        </div>
        <Link to="/projects/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </Button>
        </Link>
      </div>

      {projects.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="text-center py-12">
            <FolderOpen className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <CardTitle>No projects yet</CardTitle>
            <CardDescription>
              Create a project to start using Copilot CLI with a specific repo.
            </CardDescription>
            <Link to="/projects/new" className="mt-4 inline-block">
              <Button>Create your first project</Button>
            </Link>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}/chat`}>
              <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
                <CardHeader>
                  <FolderOpen className="h-8 w-8 mb-2 text-primary" />
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription className="space-y-1">
                    <span className="block font-mono text-xs truncate">{project.repoPath}</span>
                    {project.description && (
                      <span className="block">{project.description}</span>
                    )}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
