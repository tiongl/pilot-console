import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

describe('project lead decision thread tools', () => {
  let db: InstanceType<typeof Database>;
  let tools: Map<string, ToolLike>;
  let refreshed: string[];

  const projectId = 'p1';
  const otherProjectId = 'p2';

  function tool(name: string): ToolLike {
    const found = tools.get(name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  }

  function seedThread(id: string, project: string, status = 'open') {
    db.prepare(
      `INSERT INTO decision_threads (id, project_id, title, question, status) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, project, `Title ${id}`, `Question ${id}`, status);
  }

  beforeEach(async () => {
    vi.resetModules();
    refreshed = [];

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE decision_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        session_id TEXT,
        decision TEXT,
        rationale TEXT,
        alternatives_considered TEXT,
        user_verdict TEXT,
        follow_up_actions TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
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
    `);

    let idCounter = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `id-${++idCounter}` } as typeof crypto);

    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    vi.doMock('../shared/project-memory-store', () => ({
      getOrBootstrapProjectMemory: () => ({ summary: '' }),
      refreshProjectMemory: (id: string) => { refreshed.push(id); },
    }));
    vi.doMock('../shared/project-store', () => ({ createWorktree: vi.fn(), listWorktrees: () => [] }));
    vi.doMock('../shared/digest-store', () => ({ getDigest: () => undefined, listDigests: () => [] }));
    vi.doMock('../shared/merge-store', () => ({
      executeApprovedMerge: vi.fn(),
      getMergeRequest: vi.fn(),
      resolveMergeRequest: vi.fn(),
    }));
    vi.doMock('../shared/cos-briefing-store', () => ({ recordCosBriefing: vi.fn() }));
    vi.doMock('../shared/delegation-store', () => ({
      countActiveDelegations: () => 0,
      createDelegation: vi.fn(),
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
    const built = mod.createProjectLeadTools(projectId, 'user-1', () => 'session-42') as unknown as ToolLike[];
    tools = new Map(built.map((t, index) => [t.name ?? `unnamed-${index}`, t]));
  });

  it('registers the decision thread tools alongside the merge tools', () => {
    expect(tools.has('list_decision_threads')).toBe(true);
    expect(tools.has('resolve_decision_thread')).toBe(true);
    expect(tools.has('approve_merge')).toBe(true);
    expect(tools.has('reject_merge')).toBe(true);
  });

  it('links a recorded requirement to its originating session and audit row', () => {
    const result = tool('record_requirements').handler({
      title: 'Ship auth',
      desiredOutcome: 'Users can log in',
      acceptanceCriteria: 'Login works',
      openQuestions: 'Which provider?',
    }) as { id: string; status: string };

    expect(result.status).toBe('open');
    const row = db.prepare('SELECT session_id FROM decision_threads WHERE id = ?').get(result.id) as { session_id: string };
    expect(row.session_id).toBe('session-42');
    const entry = db.prepare("SELECT subject_id FROM project_audit_log WHERE action = 'record_requirements'").get() as { subject_id: string };
    expect(entry.subject_id).toBe(result.id);
  });

  it('lists only this project\'s open threads by default', async () => {
    seedThread('t1', projectId);
    seedThread('t2', projectId, 'resolved');
    seedThread('t3', otherProjectId);

    const open = await tool('list_decision_threads').handler({}) as { threads: Array<{ id: string }>; count: number };
    expect(open.threads.map((t) => t.id)).toEqual(['t1']);

    const all = await tool('list_decision_threads').handler({ status: 'all' }) as { threads: Array<{ id: string }> };
    expect(all.threads.map((t) => t.id).sort()).toEqual(['t1', 't2']);

    const resolved = await tool('list_decision_threads').handler({ status: 'resolved' }) as { threads: Array<{ id: string }> };
    expect(resolved.threads.map((t) => t.id)).toEqual(['t2']);
  });

  it('resolves a thread, audits it with the thread id, and refreshes memory', async () => {
    seedThread('t1', projectId);

    const result = await tool('resolve_decision_thread').handler({
      threadId: 't1',
      decision: 'Use GitHub OAuth',
      rationale: 'Already a dependency',
      followUpActions: 'Wire the callback route',
    }) as { status: string };

    expect(result.status).toBe('resolved');
    const row = db.prepare('SELECT * FROM decision_threads WHERE id = ?').get('t1') as Record<string, string>;
    expect(row.status).toBe('resolved');
    expect(row.decision).toBe('Use GitHub OAuth');
    expect(row.rationale).toBe('Already a dependency');
    expect(row.follow_up_actions).toBe('Wire the callback route');

    const entry = db.prepare("SELECT subject_id, risk_level FROM project_audit_log WHERE action = 'resolve_decision_thread'").get() as { subject_id: string; risk_level: string };
    expect(entry.subject_id).toBe('t1');
    expect(entry.risk_level).toBe('medium');
    expect(refreshed).toEqual([projectId]);
  });

  it('records a user sign-off as confirmed', async () => {
    seedThread('t1', projectId);
    await tool('resolve_decision_thread').handler({ threadId: 't1', decision: 'Approved', status: 'confirmed' });
    const row = db.prepare('SELECT status FROM decision_threads WHERE id = ?').get('t1') as { status: string };
    expect(row.status).toBe('confirmed');
  });

  it('refuses to resolve a thread from another project', async () => {
    seedThread('t3', otherProjectId);
    await expect(
      tool('resolve_decision_thread').handler({ threadId: 't3', decision: 'Nope' }),
    ).rejects.toThrow(/does not belong to this project/);
    const row = db.prepare('SELECT status FROM decision_threads WHERE id = ?').get('t3') as { status: string };
    expect(row.status).toBe('open');
  });
});
