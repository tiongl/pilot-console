import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

/**
 * The Project Lead is forbidden from polling for its workers, so a worker that
 * finishes or gets stuck has to announce it. Before this, reaching
 * `ready_to_merge` only flipped a database row and the lead never found out.
 */
describe('update_digest worker announcements', () => {
  let notified: string[];
  let marks: Array<Record<string, unknown>>;
  let delegation: Record<string, unknown> | undefined;
  let tools: Map<string, ToolLike>;

  async function build(opts: { projectId?: string | null; userId?: string } = {}) {
    const mod = await import('../shared/digest-tools');
    const built = mod.createWorktreeAgentTools(
      'wt-1',
      opts.projectId === undefined ? 'p1' : opts.projectId,
      'userId' in opts ? opts.userId : 'u1',
    ) as unknown as ToolLike[];
    tools = new Map(built.map((t, i) => [t.name ?? `unnamed-${i}`, t]));
  }

  function digest(status: string, headline = 'Work item') {
    return tools.get('update_digest')!.handler({
      headline,
      status,
      detail: 'Some detail about the work.',
      scope: 'small',
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    notified = [];
    marks = [];
    delegation = { id: 'deleg-1', title: 'Parser fix', status: 'working' };

    vi.doMock('../shared/digest-store', () => ({
      upsertDigest: () => ({ updatedAt: '2024-05-01T00:00:00Z' }),
    }));
    vi.doMock('../shared/delegation-store', () => ({
      getDelegationForWorktree: () => delegation,
      markWorktreeDelegation: (_wt: string, patch: Record<string, unknown>) => {
        marks.push(patch);
        return delegation;
      },
    }));
    vi.doMock('../shared/delegation-runtime', () => ({
      notifyProjectLead: async (_u: string, _p: string, message: string) => {
        notified.push(message);
      },
    }));

    await build();
  });

  it('tells the lead when a worker finishes, with what to do next', async () => {
    await digest('ready_to_merge', 'Parser accepts multi-source edges');

    expect(marks).toContainEqual({ status: 'done', note: 'Parser accepts multi-source edges', unread: true });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('worker finished');
    expect(notified[0]).toContain('Parser accepts multi-source edges');
    expect(notified[0]).toContain('approve_merge');
  });

  it('tells the lead when a worker blocks', async () => {
    await digest('blocked', 'Needs a decision on the schema');

    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('worker blocked');
    expect(notified[0]).toContain('nudge_worker');
  });

  // A worker re-publishing the same state must not re-notify, or a finished
  // worker would keep waking the lead.
  it('announces a state change once, not on every repeat', async () => {
    await digest('ready_to_merge');
    delegation = { ...delegation, status: 'done' };
    await digest('ready_to_merge');

    expect(notified).toHaveLength(1);
  });

  it('stays quiet for ordinary progress updates', async () => {
    await digest('in_progress');

    expect(notified).toHaveLength(0);
  });

  it('stays quiet for an ad-hoc worktree with no delegation behind it', async () => {
    delegation = undefined;
    await digest('ready_to_merge');

    expect(notified).toHaveLength(0);
  });

  // A digest is still a successful status update even if the lead is
  // unreachable; the worker must not see its own report fail.
  it('still records the digest when the lead cannot be reached', async () => {
    vi.resetModules();
    vi.doMock('../shared/digest-store', () => ({
      upsertDigest: () => ({ updatedAt: '2024-05-01T00:00:00Z' }),
    }));
    vi.doMock('../shared/delegation-store', () => ({
      getDelegationForWorktree: () => ({ id: 'deleg-1', title: 'Parser fix', status: 'working' }),
      markWorktreeDelegation: vi.fn(),
    }));
    vi.doMock('../shared/delegation-runtime', () => ({
      notifyProjectLead: async () => { throw new Error('lead unreachable'); },
    }));
    await build();

    await expect(digest('ready_to_merge')).resolves.toMatchObject({ ok: true });
  });
});
