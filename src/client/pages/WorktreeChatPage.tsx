import { useParams } from 'react-router';
import ProjectChatPage from './ProjectChatPage';

/**
 * Wraps ProjectChatPage with worktreeId context.
 * Forces remount when worktreeId changes.
 */
export default function WorktreeChatPage() {
  const { id, worktreeId } = useParams<{ id: string; worktreeId: string }>();
  return <ProjectChatPage key={`${id}-${worktreeId}`} worktreeId={worktreeId} />;
}
