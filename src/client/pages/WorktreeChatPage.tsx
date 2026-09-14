import { useLocation, useParams } from 'react-router';
import KeepAliveChat from '../components/KeepAliveChat';
import ProjectChatPage from './ProjectChatPage';
import { useProjectContextOptional } from '../lib/project-context';

/**
 * Wraps KeepAliveChat with worktreeId context for git worktree routes.
 * Uses cwd from ProjectProvider (set by WorktreeLayout) for directory-based separation.
 */
export default function WorktreeChatPage() {
  const { id, worktreeId } = useParams<{ id: string; worktreeId: string }>();
  const { search } = useLocation();
  const ctx = useProjectContextOptional();
  if (new URLSearchParams(search).get('detachedTab') === '1') {
    return <ProjectChatPage projectId={id} worktreeId={worktreeId} cwd={ctx?.cwd} />;
  }
  return <KeepAliveChat projectId={id} worktreeId={worktreeId} cwd={ctx?.cwd} />;
}
