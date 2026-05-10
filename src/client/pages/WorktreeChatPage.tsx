import { useParams } from 'react-router';
import KeepAliveChat from '../components/KeepAliveChat';

/**
 * Wraps KeepAliveChat with worktreeId context for git worktree routes.
 */
export default function WorktreeChatPage() {
  const { id, worktreeId } = useParams<{ id: string; worktreeId: string }>();
  return <KeepAliveChat projectId={id} worktreeId={worktreeId} />;
}
