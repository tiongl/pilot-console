import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router';
import ProjectHeader from '../components/project/ProjectHeader';
import ProjectTodoPanel from '../components/project/ProjectTodoPanel';
import { ProjectProvider } from '../lib/project-context';

interface Project {
  id: string;
  name: string;
  repoPath: string;
}

export default function ProjectLayout({ projectId: projectIdProp, children }: { projectId?: string; children?: React.ReactNode } = {}) {
  const { id: routeId } = useParams<{ id: string }>();
  const id = projectIdProp || routeId;
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/projects/${id}`)
      .then(r => r.json())
      .then(p => setProject(p))
      .catch(() => {});
  }, [id]);

  if (!project) return <div className="p-6 text-muted-foreground">Loading project…</div>;

  return (
    <ProjectProvider projectId={project.id} cwd={project.repoPath}>
      <ProjectHeader
        projectId={project.id}
        projectName={project.name}
        repoPath={project.repoPath}
        todoPanel={<ProjectTodoPanel projectId={project.id} projectName={project.name} />}
      >
        {children || <Outlet />}
      </ProjectHeader>
    </ProjectProvider>
  );
}
