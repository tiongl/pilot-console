import { getProjectById } from '@/lib/project-store';
import { notFound } from 'next/navigation';
import ProjectHeader from '@/components/project/ProjectHeader';
import ProjectTodoPanel from '@/components/project/ProjectTodoPanel';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = getProjectById(id);
  if (!project) notFound();

  return (
    <ProjectHeader
      projectId={project.id}
      projectName={project.name}
      repoPath={project.repoPath}
      todoPanel={<ProjectTodoPanel projectId={project.id} projectName={project.name} />}
    >
      {children}
    </ProjectHeader>
  );
}
