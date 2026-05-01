import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router';
import ProjectHeader from '../../../components/project/ProjectHeader';
import ProjectTodoPanel from '../../../components/project/ProjectTodoPanel';

interface Worktree {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
}

interface Project {
  id: string;
  name: string;
  repoPath: string;
}

export default function WorktreeLayout() {
  const { id, worktreeId } = useParams<{ id: string; worktreeId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [worktree, setWorktree] = useState<Worktree | null>(null);

  useEffect(() => {
    if (!id || !worktreeId) return;
    Promise.all([
      fetch(`/api/projects/${id}`).then(r => r.json()),
      fetch(`/api/projects/${id}/worktrees/${worktreeId}`).then(r => r.json()),
    ]).then(([p, wt]) => {
      setProject(p);
      setWorktree(wt);
    }).catch(() => {});
  }, [id, worktreeId]);

  if (!project || !worktree) return <div className="p-6 text-muted-foreground">Loading worktree…</div>;

  return (
    <ProjectHeader
      projectId={project.id}
      projectName={`${project.name} › ${worktree.name}`}
      repoPath={worktree.worktreePath}
      todoPanel={<ProjectTodoPanel projectId={project.id} projectName={project.name} />}
    >
      <Outlet />
    </ProjectHeader>
  );
}
