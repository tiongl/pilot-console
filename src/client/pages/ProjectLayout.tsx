import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router';
import ProjectHeader from '../components/project/ProjectHeader';
import ProjectTodoPanel from '../components/project/ProjectTodoPanel';

interface Project {
  id: string;
  name: string;
  repoPath: string;
}

export default function ProjectLayout() {
  const { id } = useParams<{ id: string }>();
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
    <ProjectHeader
      projectId={project.id}
      projectName={project.name}
      repoPath={project.repoPath}
      todoPanel={<ProjectTodoPanel projectId={project.id} projectName={project.name} />}
    >
      <Outlet />
    </ProjectHeader>
  );
}
