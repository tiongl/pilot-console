import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

const projectId = 'p1';

/**
 * Builds the Project Lead's tool set against in-memory stores, with the review
 * concurrency counts made controllable so the separate cap can be exercised.
 */
async function buildLeadTools(opts: { activeBuilders?: number; activeReviews?: number } = {}) {
  vi.resetModules();

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_audit_log (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      reasoning TEXT, risk_level TEXT, subject_id TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE project_autonomy_settings (
      project_id TEXT PRIMARY KEY, merge_mode TEXT NOT NULL DEFAULT 'advisory',
      intervention_mode TEXT NOT NULL DEFAULT 'flag_only', skill_install_mode TEXT NOT NULL DEFAULT 'suggest_only',
      github_task_mode TEXT NOT NULL DEFAULT 'off', dnd INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE project_todos (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, text TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO project_autonomy_settings (project_id) VALUES (?)').run(projectId);

  let idCounter = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `id-${++idCounter}` } as typeof crypto);

  let worktrees: Array<{ id: string; name: string }> = [{ id: 'wt-1', name: 'feature' }];
  const createdDelegations: Array<Record<string, unknown>> = [];
  const createAgentSession = vi.fn(async (
    _userId?: string,
    _projectId?: string,
    _worktreeId?: string,
    model?: string,
  ) => ({ sessionId: 'review-session-1', model: model ?? 'auto' }));
  const sendToSession = vi.fn(async () => {});

  vi.doMock('../shared/db', () => ({ getDb: () => db }));
  vi.doMock('../shared/agent-bridge', () => ({
    createAgentSession,
    sendToSession,
    getAgentSession: (id: string) =>
      id === 'lead-session' ? { sessionId: id, model: 'lead-model' } : undefined,
    findLiveWorktreeAgent: () => undefined,
  }));
  vi.doMock('../shared/project-memory-store', () => ({
    getOrBootstrapProjectMemory: () => ({ summary: '' }),
    refreshProjectMemory: vi.fn(),
  }));
  vi.doMock('../shared/project-store', () => ({
    createWorktree: () => ({ id: 'wt-new' }),
    listWorktrees: () => worktrees,
  }));
  vi.doMock('../shared/digest-store', () => ({ getDigest: () => undefined, listDigests: () => [] }));
  vi.doMock('../shared/merge-store', () => ({
    executeApprovedMerge: vi.fn(),
    getMergeRequest: () => undefined,
    resolveMergeRequest: vi.fn(),
  }));
  vi.doMock('../shared/cos-briefing-store', () => ({ recordCosBriefing: vi.fn() }));
  vi.doMock('../shared/delegation-store', () => ({
    countActiveDelegations: () => opts.activeBuilders ?? 0,
    countActiveReviews: () => opts.activeReviews ?? 0,
    createDelegation: (input: Record<string, unknown>) => {
      createdDelegations.push(input);
      return { id: `deleg-${createdDelegations.length}` };
    },
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
  const tools = new Map(built.map((t, i) => [t.name ?? `unnamed-${i}`, t]));

  return {
    tool: (name: string) => {
      const found = tools.get(name);
      if (!found) throw new Error(`tool ${name} not registered`);
      return found;
    },
    createAgentSession,
    sendToSession,
    createdDelegations,
    auditRows: () =>
      db.prepare('SELECT action, subject_id AS subjectId FROM project_audit_log').all() as Array<{
        action: string;
        subjectId: string | null;
      }>,
    setWorktrees: (value: Array<{ id: string; name: string }>) => { worktrees = value; },
    maxReviews: mod.MAX_ACTIVE_REVIEWS,
    maxDelegations: mod.MAX_ACTIVE_DELEGATIONS,
  };
}

describe('spin_off_review', () => {
  it('spawns an unattended autopilot review session in the given worktree and returns immediately', async () => {
    const h = await buildLeadTools();

    const result = (await h.tool('spin_off_review').handler({
      worktreeId: 'wt-1',
      focus: 'Verify the token refresh has no race',
    })) as { ok: boolean; reviewId: string; worktreeId: string; sessionId: string };

    expect(result.ok).toBe(true);
    expect(result.worktreeId).toBe('wt-1');
    expect(result.sessionId).toBe('review-session-1');

    expect(h.createAgentSession).toHaveBeenCalledTimes(1);
    const [userId, passedProjectId, worktreeId, model, kind, mode, options] =
      h.createAgentSession.mock.calls[0];
    expect({ userId, passedProjectId, worktreeId, kind, mode }).toEqual({
      userId: 'user-1',
      passedProjectId: projectId,
      worktreeId: 'wt-1',
      kind: 'agent',
      mode: 'autopilot',
    });
    expect(model).toBe('lead-model');
    expect(options).toEqual({ unattended: true });

    // The review delegation is marked distinctly from a builder.
    expect(h.createdDelegations).toHaveLength(1);
    expect(h.createdDelegations[0]).toMatchObject({ worktreeId: 'wt-1', isReview: true, deepMerge: false });

    expect(h.auditRows()).toContainEqual({ action: 'spin_off_review', subjectId: 'wt-1' });
  });

  it('seeds the reviewer with the focus brief and the optional transcript snapshot', async () => {
    const h = await buildLeadTools();

    await h.tool('spin_off_review').handler({
      worktreeId: 'wt-1',
      focus: 'Check the auth changes carefully',
      transcriptSnapshot: 'Earlier I suspected the refresh token path.',
      deepMerge: true,
    });

    expect(h.sendToSession).toHaveBeenCalledTimes(1);
    const [, prompt] = h.sendToSession.mock.calls[0] as [unknown, string];
    expect(prompt).toContain('REVIEW PERSONA');
    expect(prompt).toContain('Check the auth changes carefully');
    expect(prompt).toContain('Earlier I suspected the refresh token path.');
    expect(prompt).toMatch(/NEVER commit/);
    expect(prompt).toMatch(/pass/);
    expect(prompt).toMatch(/changes-needed/);

    expect(h.createdDelegations[0]).toMatchObject({ deepMerge: true });
  });

  it('omits the additional-context section when no snapshot is given', async () => {
    const h = await buildLeadTools();
    await h.tool('spin_off_review').handler({ worktreeId: 'wt-1', focus: 'Just the focus' });
    const [, prompt] = h.sendToSession.mock.calls[0] as [unknown, string];
    expect(prompt).not.toContain('Additional context from the Lead');
  });

  it('rejects a worktree that does not belong to this project', async () => {
    const h = await buildLeadTools();
    await expect(
      h.tool('spin_off_review').handler({ worktreeId: 'wt-other', focus: 'x' }),
    ).rejects.toThrow(/does not belong/);
    expect(h.createAgentSession).not.toHaveBeenCalled();
  });

  it('can start a review even when builders are at their cap', async () => {
    const h = await buildLeadTools({ activeBuilders: 3, activeReviews: 0 });
    expect(h.maxDelegations).toBe(3);
    const result = (await h.tool('spin_off_review').handler({ worktreeId: 'wt-1', focus: 'x' })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    expect(h.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a review once the separate review cap is reached', async () => {
    const h = await buildLeadTools({ activeReviews: 2 });
    expect(h.maxReviews).toBe(2);
    await expect(
      h.tool('spin_off_review').handler({ worktreeId: 'wt-1', focus: 'x' }),
    ).rejects.toThrow(/reviews in flight/);
    expect(h.createAgentSession).not.toHaveBeenCalled();
  });
});

/**
 * Merge-back: when the reviewer reports its verdict through update_digest, the
 * lead is notified with review-framed wording it owns, and — only on a
 * deepMerge review — a bounded condensation of the reviewer's reasoning.
 */
describe('spin_off_review merge-back', () => {
  let notified: string[];
  let upserts: Array<Record<string, unknown>>;
  let delegation: Record<string, unknown> | undefined;
  let reasoning: string;
  let tools: Map<string, ToolLike>;

  async function build() {
    const mod = await import('../shared/digest-tools');
    const built = mod.createWorktreeAgentTools('wt-1', 'p1', 'u1') as unknown as ToolLike[];
    tools = new Map(built.map((t, i) => [t.name ?? `unnamed-${i}`, t]));
  }

  function report(status: string, headline: string, detail: string) {
    return tools.get('update_digest')!.handler({ headline, status, detail, scope: 'small' });
  }

  beforeEach(async () => {
    vi.resetModules();
    notified = [];
    upserts = [];
    reasoning = 'I read the diff, ran the suite, and traced the refresh path.';

    vi.doMock('../shared/digest-store', () => ({
      upsertDigest: (_wt: string, input: Record<string, unknown>) => {
        upserts.push(input);
        return { updatedAt: '2024-05-01T00:00:00Z' };
      },
    }));
    vi.doMock('../shared/delegation-store', () => ({
      getDelegationForWorktree: () => delegation,
      markWorktreeDelegation: () => delegation,
    }));
    vi.doMock('../shared/delegation-runtime', () => ({
      notifyProjectLead: async (_u: string, _p: string, message: string) => {
        notified.push(message);
      },
    }));
    vi.doMock('../shared/agent-bridge', () => ({
      summarizeSessionReasoning: () => reasoning,
    }));

    await build();
  });

  it('notifies the lead with a review-finished verdict and persists it to the digest', async () => {
    delegation = { id: 'r1', title: 'Review: feature', status: 'working', isReview: 1, deepMerge: 0, sessionId: 's1' };
    await report('ready_to_merge', 'pass — token refresh is safe', 'No race found; src/auth.ts:88 is guarded.');

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ headline: 'pass — token refresh is safe' });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('review finished');
    expect(notified[0]).toContain('Verdict: pass');
    expect(notified[0]).toContain('src/auth.ts:88');
    expect(notified[0]).toContain('approve_merge');
  });

  it('frames a changes-needed verdict with the follow-up action', async () => {
    delegation = { id: 'r1', title: 'Review: feature', status: 'working', isReview: 1, deepMerge: 0, sessionId: 's1' };
    await report('blocked', 'changes-needed — race in refresh', 'Token refresh races at src/auth.ts:88.');

    expect(notified[0]).toContain('review finished');
    expect(notified[0]).toContain('Verdict: changes-needed');
    expect(notified[0]).toContain('nudge_worker');
  });

  it('does NOT fold in the reviewer reasoning when deepMerge is off', async () => {
    delegation = { id: 'r1', title: 'Review: feature', status: 'working', isReview: 1, deepMerge: 0, sessionId: 's1' };
    await report('ready_to_merge', 'pass', 'Looks good.');
    expect(notified[0]).not.toContain('My reasoning');
    expect(notified[0]).not.toContain(reasoning);
  });

  it('folds in a bounded reasoning summary when deepMerge is on', async () => {
    delegation = { id: 'r1', title: 'Review: feature', status: 'working', isReview: 1, deepMerge: 1, sessionId: 's1' };
    await report('ready_to_merge', 'pass', 'Looks good.');
    expect(notified[0]).toContain('My reasoning');
    expect(notified[0]).toContain(reasoning);
  });

  it('still uses the builder wording for a non-review delegation', async () => {
    delegation = { id: 'd1', title: 'Parser fix', status: 'working', isReview: 0, deepMerge: 0, sessionId: 's1' };
    await report('ready_to_merge', 'done', 'Parser fixed.');
    expect(notified[0]).toContain('worker finished');
    expect(notified[0]).not.toContain('Verdict:');
  });
});
