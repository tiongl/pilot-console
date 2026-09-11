import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

interface Harness {
  tool: (name: string) => ToolLike;
  createAgentSession: ReturnType<typeof vi.fn>;
  sendToSession: ReturnType<typeof vi.fn>;
  cancelAgent: ReturnType<typeof vi.fn>;
  updated: Array<[string, Record<string, unknown>]>;
  setLiveAgent: (value: { sessionId: string } | undefined) => void;
  setDelegation: (value: Record<string, unknown> | undefined) => void;
}

const projectId = 'p1';

/**
 * Builds the Project Lead's tool set against in-memory stores. Each call gets
 * its own module registry so mocked state cannot leak between tests.
 */
async function buildTools(options: { interventionMode?: string } = {}): Promise<Harness> {
  vi.resetModules();

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_audit_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      risk_level TEXT,
      subject_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE project_autonomy_settings (
      project_id TEXT PRIMARY KEY,
      merge_mode TEXT NOT NULL DEFAULT 'advisory',
      intervention_mode TEXT NOT NULL DEFAULT 'flag_only',
      dnd INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO project_autonomy_settings (project_id, intervention_mode) VALUES (?, ?)').run(
    projectId,
    options.interventionMode ?? 'flag_only',
  );

  let idCounter = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `id-${++idCounter}` } as typeof crypto);

  let liveWorktreeAgent: { sessionId: string } | undefined;
  let delegationForWorktree: Record<string, unknown> | undefined;
  const updated: Array<[string, Record<string, unknown>]> = [];

  const createAgentSession = vi.fn(async () => ({ sessionId: 'worker-session-1' }));
  const sendToSession = vi.fn(async () => {});
  const cancelAgent = vi.fn(async () => {});

  vi.doMock('../shared/db', () => ({ getDb: () => db }));
  vi.doMock('../shared/agent-bridge', () => ({
    createAgentSession,
    sendToSession,
    cancelAgent,
    findLiveWorktreeAgent: () => liveWorktreeAgent,
  }));
  vi.doMock('../shared/project-memory-store', () => ({
    getOrBootstrapProjectMemory: () => ({ summary: '' }),
    refreshProjectMemory: vi.fn(),
  }));
  vi.doMock('../shared/project-store', () => ({
    createWorktree: () => ({ id: 'wt-new' }),
    listWorktrees: () => [],
  }));
  vi.doMock('../shared/digest-store', () => ({ getDigest: () => undefined, listDigests: () => [] }));
  vi.doMock('../shared/merge-store', () => ({
    executeApprovedMerge: vi.fn(),
    getMergeRequest: vi.fn(),
    resolveMergeRequest: vi.fn(),
  }));
  vi.doMock('../shared/cos-briefing-store', () => ({ recordCosBriefing: vi.fn() }));
  vi.doMock('../shared/delegation-store', () => ({
    countActiveDelegations: () => 0,
    createDelegation: () => ({ id: 'deleg-1' }),
    getDelegationForWorktree: () => delegationForWorktree,
    listDelegations: () => [],
    markWorktreeDelegation: vi.fn(),
    shortTitle: (value: string) => value,
    updateDelegation: (id: string, patch: Record<string, unknown>) => {
      updated.push([id, patch]);
      return undefined;
    },
  }));
  vi.doMock('../shared/delegation-runtime', () => ({
    hasPendingPlanReview: () => false,
    resolveLeadPlanReview: vi.fn(),
  }));

  const mod = await import('../shared/project-lead-tools');
  const built = mod.createProjectLeadTools(projectId, 'user-1', () => 'lead-session') as unknown as ToolLike[];
  const tools = new Map(built.map((t, index) => [t.name ?? `unnamed-${index}`, t]));

  return {
    tool: (name: string) => {
      const found = tools.get(name);
      if (!found) throw new Error(`tool ${name} not registered`);
      return found;
    },
    createAgentSession,
    sendToSession,
    cancelAgent,
    updated,
    setLiveAgent: (value) => { liveWorktreeAgent = value; },
    setDelegation: (value) => { delegationForWorktree = value; },
  };
}

/**
 * A delegated worker runs with no client subscribed to it. If it is allowed to
 * raise a permission prompt, nothing can ever answer it and the worker sits
 * blocked on its first tool call, which is what "delegation does nothing"
 * looked like from the outside.
 */
describe('delegate_to_worker', () => {
  it('starts the worker unattended so it never blocks on a permission prompt', async () => {
    const harness = await buildTools();

    const result = (await harness.tool('delegate_to_worker').handler({
      task: 'Fix the parser',
      title: 'Parser fix',
    })) as { ok: boolean; sessionId: string };

    expect(result.ok).toBe(true);
    expect(harness.createAgentSession).toHaveBeenCalledTimes(1);
    const [userId, passedProjectId, worktreeId, model, kind, mode, options] =
      harness.createAgentSession.mock.calls[0];
    expect({ userId, passedProjectId, worktreeId, kind, mode }).toEqual({
      userId: 'user-1',
      passedProjectId: projectId,
      worktreeId: 'wt-new',
      kind: 'agent',
      mode: 'plan',
    });
    expect(model).toBeUndefined();
    expect(options).toEqual({ unattended: true });
  });

  it('hands the worker its task once the session exists', async () => {
    const harness = await buildTools();

    await harness.tool('delegate_to_worker').handler({ task: 'Fix the parser', title: 'Parser fix' });

    expect(harness.sendToSession).toHaveBeenCalledTimes(1);
    const [session, prompt] = harness.sendToSession.mock.calls[0];
    expect((session as { sessionId: string }).sessionId).toBe('worker-session-1');
    expect(prompt).toContain('Fix the parser');
  });
});

/**
 * Closing out a worker that has already stopped is the normal way to clear a
 * dead delegation. Reporting that as an error left the lead unable to free the
 * slot or retry the work.
 */
describe('cancel_worker', () => {
  it('succeeds when the worker has already stopped, and says the worktree can be reused', async () => {
    const harness = await buildTools();
    harness.setDelegation({ id: 'deleg-1', status: 'working' });
    harness.setLiveAgent(undefined);

    const result = (await harness.tool('cancel_worker').handler({
      worktreeId: 'wt-1',
      reason: 'stopped responding',
    })) as { ok: boolean; sessionId: string | null; note: string };

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(result.note).toContain('delegate_to_worker');
    expect(result.note).toContain('wt-1');
    expect(harness.updated).toContainEqual([
      'deleg-1',
      { status: 'cancelled', note: 'stopped responding', unread: false },
    ]);
  });

  it('stops a worker that is still live', async () => {
    const harness = await buildTools();
    harness.setDelegation({ id: 'deleg-1', status: 'working' });
    harness.setLiveAgent({ sessionId: 'worker-session-1' });

    const result = (await harness.tool('cancel_worker').handler({
      worktreeId: 'wt-1',
      reason: 'no longer needed',
    })) as { ok: boolean; sessionId: string | null };

    expect(result.sessionId).toBe('worker-session-1');
    expect(harness.cancelAgent).toHaveBeenCalledWith('worker-session-1');
  });

  // Without a delegation of its own there is nothing to close out, so a
  // missing session really is a failure.
  it('still fails for a worker it did not start when no session is live', async () => {
    const harness = await buildTools({ interventionMode: 'flag_nudge_cancel' });
    harness.setDelegation(undefined);
    harness.setLiveAgent(undefined);

    await expect(
      harness.tool('cancel_worker').handler({ worktreeId: 'wt-1', reason: 'cleanup' }),
    ).rejects.toThrow('No live worktree agent session found');
  });
});
