import { useParams } from 'react-router';
import KeepAliveChat from '../components/KeepAliveChat';
import { useProjectContextOptional } from '../lib/project-context';

/**
 * Wraps KeepAliveChat with worktreeId context for git worktree routes.
 * Uses cwd from ProjectProvider (set by WorktreeLayout) for directory-based separation.
 */
export default function WorktreeChatPage() {
  const { id, worktreeId } = useParams<{ id: string; worktreeId: string }>();
  const ctx = useProjectContextOptional();
  return <KeepAliveChat projectId={id} worktreeId={worktreeId} cwd={ctx?.cwd} />;
}
