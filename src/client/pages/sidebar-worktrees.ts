/**
 * Which projects' worktree lists are out of date, given the delegations the
 * sidebar just polled.
 *
 * The sidebar only ever noticed worktrees *appearing*. Now that the Project
 * Lead retires a merged worktree on its own — deleting its delegations and the
 * worktree with them — the tree also has to notice them going away, or it keeps
 * drawing worktrees that no longer exist until the page is reloaded.
 *
 * `appeared` projects are also revealed to the user; `retired` ones are only
 * refreshed, since forcing a project open because something vanished from it
 * would fight the user's collapse.
 */
export function reconcileDelegatedWorktrees(input: {
  /** Worktrees currently drawn, per project. */
  worktreesByProject: Record<string, Array<{ id: string }>>;
  /** Delegations from this poll, keyed by worktree id. */
  delegationsByWorktree: Record<string, { projectId: string; status?: string }>;
  /** Worktree ids that had a delegation on the previous poll. */
  knownDelegated: Set<string>;
}): { appeared: Set<string>; retired: Set<string> } {
  const { worktreesByProject, delegationsByWorktree, knownDelegated } = input;

  const appeared = new Set<string>();
  for (const [worktreeId, delegation] of Object.entries(delegationsByWorktree)) {
    const drawn = worktreesByProject[delegation.projectId] || [];
    if (!drawn.some((w) => w.id === worktreeId)) appeared.add(delegation.projectId);
  }

  const retired = new Set<string>();
  for (const [projectId, worktrees] of Object.entries(worktreesByProject)) {
    for (const worktree of worktrees) {
      const delegation = delegationsByWorktree[worktree.id];
      // Gone from the list entirely, or explicitly closed out. A worktree that
      // never had a delegation is left alone: those are the user's own.
      const wentAway = knownDelegated.has(worktree.id) && !delegation;
      if (wentAway || delegation?.status === 'closed') retired.add(projectId);
    }
  }

  // One refresh per project is enough, and `appeared` already covers it.
  for (const projectId of appeared) retired.delete(projectId);
  return { appeared, retired };
}
