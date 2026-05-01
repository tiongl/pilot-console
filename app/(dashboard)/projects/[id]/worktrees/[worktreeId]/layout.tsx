import { getProjectById, getWorktreeById } from '@/lib/project-store';
import { notFound } from 'next/navigation';
import ProjectHeader from '@/components/project/ProjectHeader';
import ProjectTodoPanel from '@/components/project/ProjectTodoPanel';

export default async function WorktreeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string; worktreeId: string }>;
}) {
  const { id, worktreeId } = await params;
  const project = getProjectById(id);
  if (!project) notFound();
  const worktree = getWorktreeById(worktreeId);
  if (!worktree || worktree.projectId !== id) notFound();

  return (
    <ProjectHeader
      projectId={project.id}
      projectName={`${project.name} › ${worktree.name}`}
      repoPath={worktree.worktreePath}
      todoPanel={<ProjectTodoPanel projectId={project.id} projectName={project.name} />}
    >
      {children}
    </ProjectHeader>
  );
}
