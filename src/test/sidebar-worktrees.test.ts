import { describe, expect, it } from 'vitest';
import { reconcileDelegatedWorktrees } from '@/pages/sidebar-worktrees';

const p1 = 'project-1';
const p2 = 'project-2';

describe('reconcileDelegatedWorktrees', () => {
  it('reveals a project whose worktree the lead just created', () => {
    const { appeared, retired } = reconcileDelegatedWorktrees({
      worktreesByProject: { [p1]: [] },
      delegationsByWorktree: { 'wt-new': { projectId: p1, status: 'working' } },
      knownDelegated: new Set(),
    });

    expect([...appeared]).toEqual([p1]);
    expect([...retired]).toEqual([]);
  });

  /**
   * The whole point of the fix: the lead retires a merged worktree itself,
   * which deletes its delegation rows. Without this the sidebar kept drawing
   * the worktree until the user reloaded.
   */
  it('refreshes a project whose delegated worktree has gone away', () => {
    const { appeared, retired } = reconcileDelegatedWorktrees({
      worktreesByProject: { [p1]: [{ id: 'wt-1' }] },
      delegationsByWorktree: {},
      knownDelegated: new Set(['wt-1']),
    });

    expect([...retired]).toEqual([p1]);
    expect([...appeared]).toEqual([]);
  });

  // There is a window between the delegation being marked closed and the
  // worktree row actually going, and a poll can land in it.
  it('refreshes a project whose delegation was closed out', () => {
    const { retired } = reconcileDelegatedWorktrees({
      worktreesByProject: { [p1]: [{ id: 'wt-1' }] },
      delegationsByWorktree: { 'wt-1': { projectId: p1, status: 'closed' } },
      knownDelegated: new Set(['wt-1']),
    });

    expect([...retired]).toEqual([p1]);
  });

  /**
   * Worktrees the user made by hand never had a delegation. Treating their
   * absence from the delegation list as a removal would refetch every project
   * on every poll, for ever.
   */
  it('leaves worktrees that never had a delegation alone', () => {
    const { appeared, retired } = reconcileDelegatedWorktrees({
      worktreesByProject: { [p1]: [{ id: 'wt-manual' }] },
      delegationsByWorktree: {},
      knownDelegated: new Set(),
    });

    expect([...retired]).toEqual([]);
    expect([...appeared]).toEqual([]);
  });

  it('does nothing while a delegated worktree is still running', () => {
    const { appeared, retired } = reconcileDelegatedWorktrees({
      worktreesByProject: { [p1]: [{ id: 'wt-1' }] },
      delegationsByWorktree: { 'wt-1': { projectId: p1, status: 'working' } },
      knownDelegated: new Set(['wt-1']),
    });

    expect([...appeared]).toEqual([]);
    expect([...retired]).toEqual([]);
  });

  it('only reports the project that actually changed', () => {
    const { retired } = reconcileDelegatedWorktrees({
      worktreesByProject: { [p1]: [{ id: 'wt-1' }], [p2]: [{ id: 'wt-2' }] },
      delegationsByWorktree: { 'wt-2': { projectId: p2, status: 'working' } },
      knownDelegated: new Set(['wt-1', 'wt-2']),
    });

    expect([...retired]).toEqual([p1]);
  });

  // A project that gained one worktree and lost another needs a single
  // refresh, and should still be revealed.
  it('does not report one project as both new and retired', () => {
    const { appeared, retired } = reconcileDelegatedWorktrees({
      worktreesByProject: { [p1]: [{ id: 'wt-old' }] },
      delegationsByWorktree: { 'wt-new': { projectId: p1, status: 'working' } },
      knownDelegated: new Set(['wt-old']),
    });

    expect([...appeared]).toEqual([p1]);
    expect([...retired]).toEqual([]);
  });
});
