import { auth } from '@/lib/auth';
import { getProjectById } from '@/lib/project-store';
import { notFound } from 'next/navigation';
import ChatClient from '@/app/(dashboard)/chat/ChatClient';

export default async function ProjectChatPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;
  const project = getProjectById(id);
  if (!project) notFound();

  return <ChatClient key={project.id} userName={session?.user?.name ?? null} projectId={project.id} />;
}
