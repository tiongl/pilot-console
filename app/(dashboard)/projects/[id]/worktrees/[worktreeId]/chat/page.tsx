import { auth } from '@/lib/auth';
import { getProjectById, getWorktreeById } from '@/lib/project-store';
import { notFound } from 'next/navigation';
import ChatClient from '@/app/(dashboard)/chat/ChatClient';

export default async function WorktreeChatPage({
  params,
}: {
  params: Promise<{ id: string; worktreeId: string }>;
}) {
  const session = await auth();
  const { id, worktreeId } = await params;
  const project = getProjectById(id);
  if (!project) notFound();
  const worktree = getWorktreeById(worktreeId);
  if (!worktree || worktree.projectId !== id) notFound();

  return (
    <ChatClient
      key={`${project.id}-${worktree.id}`}
      userName={session?.user?.name ?? null}
      projectId={project.id}
      worktreeId={worktree.id}
    />
  );
}
