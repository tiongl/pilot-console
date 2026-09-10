import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { Worktree } from '@/types';

/**
 * Returns a `start(issueNumber)` action that starts or resumes work on a GitHub
 * issue: it creates (or reuses) the issue's dedicated worktree, then navigates
 * to that worktree's chat so the Copilot session begins/resumes. The left nav
 * follows because the URL changes to the worktree route. `startingIssue` tracks
 * which issue is in flight (for per-card spinners).
 */
export function useStartIssueSession(consoleProjectId: string) {
  const navigate = useNavigate();
  const [startingIssue, setStartingIssue] = useState<number | null>(null);

  const start = useCallback(
    async (issueNumber: number) => {
      setStartingIssue(issueNumber);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(consoleProjectId)}/github/issues/${issueNumber}/start-work`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        );
        const body = (await res.json().catch(() => ({}))) as { worktree?: Worktree; resumed?: boolean; error?: string };
        if (!res.ok || !body.worktree) throw new Error(body.error || `Failed to start work (${res.status})`);
        toast.success(body.resumed ? `Resuming work on #${issueNumber}` : `Started work on #${issueNumber}`);
        // Let the project tree add/refresh the worktree subnode for this project.
        window.dispatchEvent(new CustomEvent('worktrees-changed', { detail: { projectId: consoleProjectId } }));
        navigate(`/projects/${consoleProjectId}/worktrees/${body.worktree.id}/chat`);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setStartingIssue(null);
      }
    },
    [consoleProjectId, navigate],
  );

  return { start, startingIssue };
}
