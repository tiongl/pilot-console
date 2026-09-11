import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

/**
 * A delegated worker runs with no client subscribed to it. If it is allowed to
 * raise a permission prompt, nothing can ever answer it and the worker sits
 * blocked on its first tool call, which is what "delegation does nothing"
 * looked like from the outside.
 */
describe('delegate_to_worker', () => {
  let db: InstanceType<typeof Database>;
  let tools: Map<string, ToolLike>;
  let createAgentSession: ReturnType<typeof vi.fn>;
  let sendToSession: ReturnType<typeof vi.fn>;
  let createdWorktrees: unknown[];

  const projectId = 'p1';

  function tool(name: string): ToolLike {
    const found = tools.get(name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  }

  beforeEach(async () => {
    vi.resetModules();
    createdWorktrees = [];

    db = new Database(':memory:');
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

    let idCounter = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `id-${++idCounter}` } as typeof crypto);

    createAgentSession = vi.fn(async () => ({ sessionId: 'worker-session-1' }));
    sendToSession = vi.fn(async () => {});

    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    vi.doMock('../shared/agent-bridge', () => ({ createAgentSession, sendToSession }));
    vi.doMock('../shared/project-memory-store', () => ({
      getOrBootstrapProjectMemory: () => ({ summary: '' }),
      refreshProjectMemory: vi.fn(),
    }));
    vi.doMock('../shared/project-store', () => ({
      createWorktree: (...args: unknown[]) => {
        createdWorktrees.push(args);
        return { id: 'wt-new' };
      },
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
      getDelegationForWorktree: () => undefined,
      listDelegations: () => [],
      markWorktreeDelegation: vi.fn(),
      shortTitle: (value: string) => value,
      updateDelegation: vi.fn(),
    }));
    vi.doMock('../shared/delegation-runtime', () => ({
      hasPendingPlanReview: () => false,
      resolveLeadPlanReview: vi.fn(),
    }));

    const mod = await import('../shared/project-lead-tools');
    const built = mod.createProjectLeadTools(projectId, 'user-1', () => 'lead-session') as unknown as ToolLike[];
    tools = new Map(built.map((t, index) => [t.name ?? `unnamed-${index}`, t]));
  });

  it('starts the worker unattended so it never blocks on a permission prompt', async () => {
    const result = (await tool('delegate_to_worker').handler({
      task: 'Fix the parser',
      title: 'Parser fix',
    })) as { ok: boolean; sessionId: string };

    expect(result.ok).toBe(true);
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const [userId, passedProjectId, worktreeId, model, kind, mode, options] =
      createAgentSession.mock.calls[0];
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
    await tool('delegate_to_worker').handler({ task: 'Fix the parser', title: 'Parser fix' });

    expect(sendToSession).toHaveBeenCalledTimes(1);
    const [session, prompt] = sendToSession.mock.calls[0];
    expect((session as { sessionId: string }).sessionId).toBe('worker-session-1');
    expect(prompt).toContain('Fix the parser');
  });
});
