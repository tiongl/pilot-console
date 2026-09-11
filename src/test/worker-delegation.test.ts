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
  sendAgentMessage: ReturnType<typeof vi.fn>;
  cancelAgent: ReturnType<typeof vi.fn>;
  endAgentSession: ReturnType<typeof vi.fn>;
  endWorktreeAgentSessions: ReturnType<typeof vi.fn>;
  resumeAgentSession: ReturnType<typeof vi.fn>;
  updated: Array<[string, Record<string, unknown>]>;
  setLiveAgent: (value: { sessionId: string } | undefined) => void;
  setDelegation: (value: Record<string, unknown> | undefined) => void;
  setMergeRequest: (value: Record<string, unknown> | undefined) => void;
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
  let mergeRequest: Record<string, unknown> | undefined;
  const updated: Array<[string, Record<string, unknown>]> = [];
  const executeMerge = vi.fn(async () => ({ pullRequestUrl: 'https://example/pr/1' }));

  const createAgentSession = vi.fn(async () => ({ sessionId: 'worker-session-1' }));
  const sendToSession = vi.fn(async () => {});
  const sendAgentMessage = vi.fn(async () => {});
  const cancelAgent = vi.fn(async () => {});
  const endAgentSession = vi.fn(async () => {});
  const endWorktreeAgentSessions = vi.fn(async () => []);
  const resumeAgentSession = vi.fn(async () => ({ sessionId: 'worker-session-resumed' }));

  vi.doMock('../shared/db', () => ({ getDb: () => db }));
  vi.doMock('../shared/agent-bridge', () => ({
    createAgentSession,
    sendToSession,
    sendAgentMessage,
    cancelAgent,
    endAgentSession,
    endWorktreeAgentSessions,
    resumeAgentSession,
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
    executeApprovedMerge: executeMerge,
    getMergeRequest: () => mergeRequest,
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
    sendAgentMessage,
    cancelAgent,
    endAgentSession,
    endWorktreeAgentSessions,
    resumeAgentSession,
    updated,
    setLiveAgent: (value) => { liveWorktreeAgent = value; },
    setDelegation: (value) => { delegationForWorktree = value; },
    setMergeRequest: (value: Record<string, unknown> | undefined) => { mergeRequest = value; },
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

  it('stops a worker that is still live and closes its session', async () => {
    const harness = await buildTools();
    harness.setDelegation({ id: 'deleg-1', status: 'working' });
    harness.setLiveAgent({ sessionId: 'worker-session-1' });

    const result = (await harness.tool('cancel_worker').handler({
      worktreeId: 'wt-1',
      reason: 'no longer needed',
    })) as { ok: boolean; sessionId: string | null };

    expect(result.sessionId).toBe('worker-session-1');
    expect(harness.cancelAgent).toHaveBeenCalledWith('worker-session-1');
    // Interrupting the turn alone left the session connected and idle forever.
    expect(harness.endAgentSession).toHaveBeenCalledWith('worker-session-1');
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

/**
 * Worker sessions are released on a server restart and deliberately released
 * once a delegation is closed out, but the conversation survives. Treating
 * "not live in this process" as "gone" left the lead unable to answer a worker
 * that was perfectly resumable.
 */
describe('nudge_worker', () => {
  it('resumes a worker whose session is no longer live in this process', async () => {
    const harness = await buildTools();
    harness.setDelegation({ id: 'deleg-1', status: 'working', sessionId: 'worker-session-1' });
    harness.setLiveAgent(undefined);

    const result = (await harness.tool('nudge_worker').handler({
      worktreeId: 'wt-1',
      message: 'use the new parser API',
    })) as { ok: boolean; sessionId: string };

    expect(harness.resumeAgentSession).toHaveBeenCalledWith('user-1', 'worker-session-1');
    expect(result.sessionId).toBe('worker-session-resumed');
    expect(harness.sendAgentMessage).toHaveBeenCalledWith('worker-session-resumed', 'use the new parser API');
  });

  it('does not resume when the delegation never recorded a session', async () => {
    const harness = await buildTools();
    harness.setDelegation({ id: 'deleg-1', status: 'working' });
    harness.setLiveAgent(undefined);

    await expect(
      harness.tool('nudge_worker').handler({ worktreeId: 'wt-1', message: 'hello' }),
    ).rejects.toThrow('No live worktree agent session found');
    expect(harness.resumeAgentSession).not.toHaveBeenCalled();
  });

  it('uses the live session without resuming when one is already open', async () => {
    const harness = await buildTools();
    harness.setDelegation({ id: 'deleg-1', status: 'working', sessionId: 'worker-session-1' });
    harness.setLiveAgent({ sessionId: 'worker-session-1' });

    await harness.tool('nudge_worker').handler({ worktreeId: 'wt-1', message: 'hello' });

    expect(harness.resumeAgentSession).not.toHaveBeenCalled();
    expect(harness.sendAgentMessage).toHaveBeenCalledWith('worker-session-1', 'hello');
  });
});

/**
 * Once the work is submitted the worker has nothing left to do, so its session
 * is released rather than left connected forever.
 */
describe('approve_merge', () => {
  it('releases the worktree worker session after the merge is executed', async () => {
    const harness = await buildTools();
    harness.setMergeRequest({ id: 'mr-1', projectId, worktreeId: 'wt-1' });

    await harness.tool('approve_merge').handler({ requestId: 'mr-1', note: 'looks good' });

    expect(harness.endWorktreeAgentSessions).toHaveBeenCalledWith(projectId, 'wt-1');
  });

  it('still returns the merge result when releasing the session fails', async () => {
    const harness = await buildTools();
    harness.setMergeRequest({ id: 'mr-1', projectId, worktreeId: 'wt-1' });
    harness.endWorktreeAgentSessions.mockRejectedValueOnce(new Error('disconnect failed'));

    const result = (await harness.tool('approve_merge').handler({ requestId: 'mr-1' })) as {
      pullRequestUrl: string;
    };

    expect(result.pullRequestUrl).toBe('https://example/pr/1');
  });
});
