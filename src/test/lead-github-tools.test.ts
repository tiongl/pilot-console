import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

interface Harness {
  names: string[];
  tool: (name: string) => ToolLike;
  store: {
    listIssues: ReturnType<typeof vi.fn>;
    getIssueDetail: ReturnType<typeof vi.fn>;
    listPullRequests: ReturnType<typeof vi.fn>;
    listMilestones: ReturnType<typeof vi.fn>;
    getBoard: ReturnType<typeof vi.fn>;
    createBoardIssue: ReturnType<typeof vi.fn>;
    updateIssue: ReturnType<typeof vi.fn>;
    createPullRequest: ReturnType<typeof vi.fn>;
    moveBoardItem: ReturnType<typeof vi.fn>;
    getDefaultProjectLink: ReturnType<typeof vi.fn>;
  };
  auditRows: () => Array<{ action: string; reasoning: string }>;
}

const projectId = 'p1';

const READ_TOOLS = ['list_github_issues', 'get_github_issue', 'list_pull_requests', 'list_milestones', 'get_github_board'];
const WRITE_TOOLS = ['create_github_issue', 'update_github_issue', 'open_pull_request', 'move_board_item'];

class GitHubCliError extends Error {
  code: string;
  constructor(message: string, code = 'failed') {
    super(message);
    this.name = 'GitHubCliError';
    this.code = code;
  }
}

async function buildTools(options: { githubTaskMode?: string } = {}): Promise<Harness> {
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
      skill_install_mode TEXT NOT NULL DEFAULT 'suggest_only',
      github_task_mode TEXT NOT NULL DEFAULT 'off',
      dnd INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO project_autonomy_settings (project_id, github_task_mode) VALUES (?, ?)').run(
    projectId,
    options.githubTaskMode ?? 'off',
  );

  let idCounter = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `id-${++idCounter}` } as typeof crypto);

  const store = {
    listIssues: vi.fn(async () => [{ number: 1, title: 'issue' }]),
    getIssueDetail: vi.fn(async (_pid: string, number: number) => ({ number, title: 'issue', body: 'body' })),
    listPullRequests: vi.fn(async () => [{ number: 2, title: 'pr' }]),
    listMilestones: vi.fn(async () => [{ number: 1, title: 'm1' }]),
    getBoard: vi.fn(async () => ({ columns: [] })),
    createBoardIssue: vi.fn(async () => ({ itemId: 'item-1', number: 7, url: 'https://x/issues/7' })),
    updateIssue: vi.fn(async () => undefined),
    createPullRequest: vi.fn(async () => ({ number: 9, url: 'https://x/pull/9' })),
    moveBoardItem: vi.fn(async () => undefined),
    getDefaultProjectLink: vi.fn(() => ({ ghProjectId: 'PVT_1' })),
  };

  vi.doMock('../shared/db', () => ({ getDb: () => db }));
  vi.doMock('../shared/github-store', () => ({ ...store, GitHubCliError }));

  // Static imports pulled in by project-lead-tools that we don't exercise here.
  vi.doMock('../shared/agent-bridge', () => ({
    getAgentSession: () => undefined,
    findLiveWorktreeAgent: () => undefined,
    resumeAgentSession: vi.fn(),
    sendAgentMessage: vi.fn(),
    cancelAgent: vi.fn(),
    endAgentSession: vi.fn(),
  }));
  vi.doMock('../shared/project-memory-store', () => ({
    getOrBootstrapProjectMemory: () => ({ summary: '' }),
    refreshProjectMemory: vi.fn(),
  }));
  vi.doMock('../shared/project-store', () => ({ createWorktree: vi.fn(), listWorktrees: () => [] }));
  vi.doMock('../shared/worktree-cleanup', () => ({ assessWorktreeCleanup: vi.fn(), closeWorktree: vi.fn() }));
  vi.doMock('../shared/digest-store', () => ({ getDigest: () => undefined, listDigests: () => [] }));
  vi.doMock('../shared/merge-store', () => ({
    executeApprovedMerge: vi.fn(),
    getMergeRequest: () => undefined,
    resolveMergeRequest: vi.fn(),
  }));
  vi.doMock('../shared/cos-briefing-store', () => ({ recordCosBriefing: vi.fn() }));
  vi.doMock('../shared/delegation-store', () => ({
    countActiveDelegations: () => 0,
    countActiveReviews: () => 0,
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
  const built = mod.createProjectLeadTools(projectId, 'user-1', () => undefined) as unknown as ToolLike[];
  const tools = new Map(built.map((t, index) => [t.name ?? `unnamed-${index}`, t]));

  return {
    names: built.map((t) => t.name ?? ''),
    tool: (name: string) => {
      const found = tools.get(name);
      if (!found) throw new Error(`tool ${name} not registered`);
      return found;
    },
    store,
    auditRows: () =>
      db.prepare('SELECT action, reasoning FROM project_audit_log ORDER BY created_at, id').all() as Array<{
        action: string;
        reasoning: string;
      }>,
  };
}

describe('github task tool registration', () => {
  it('registers none of the gh tools when mode is off', async () => {
    const harness = await buildTools({ githubTaskMode: 'off' });
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(harness.names).not.toContain(name);
    }
  });

  it('registers the 5 read tools and no write tools when mode is read_only', async () => {
    const harness = await buildTools({ githubTaskMode: 'read_only' });
    for (const name of READ_TOOLS) expect(harness.names).toContain(name);
    for (const name of WRITE_TOOLS) expect(harness.names).not.toContain(name);
  });

  it('registers read + write tools when mode is manage', async () => {
    const harness = await buildTools({ githubTaskMode: 'manage' });
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) expect(harness.names).toContain(name);
  });
});

describe('github read tools', () => {
  it('list_github_issues wraps the store reader', async () => {
    const harness = await buildTools({ githubTaskMode: 'read_only' });
    const result = (await harness.tool('list_github_issues').handler({})) as { ok: boolean; issues: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(harness.store.listIssues).toHaveBeenCalledWith(projectId);
  });

  it('get_github_board returns a structured error when no board is linked', async () => {
    const harness = await buildTools({ githubTaskMode: 'read_only' });
    harness.store.getDefaultProjectLink.mockReturnValue(null);
    const result = (await harness.tool('get_github_board').handler({})) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no github project/i);
    expect(harness.store.getBoard).not.toHaveBeenCalled();
  });

  it('wraps GitHubCliError into a structured result rather than throwing', async () => {
    const harness = await buildTools({ githubTaskMode: 'read_only' });
    harness.store.listIssues.mockRejectedValue(new GitHubCliError('nope', 'not-authenticated'));
    const result = (await harness.tool('list_github_issues').handler({})) as { ok: boolean; code: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not-authenticated');
  });
});

describe('github write tool gating', () => {
  it('create_github_issue refuses without confirmed and does not call the store', async () => {
    const harness = await buildTools({ githubTaskMode: 'manage' });
    const result = (await harness.tool('create_github_issue').handler({ title: 'New' })) as { ok: boolean; confirmed: boolean };
    expect(result.ok).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(harness.store.createBoardIssue).not.toHaveBeenCalled();
    expect(harness.auditRows()).toHaveLength(0);
  });

  it('create_github_issue files the issue and audits it once confirmed', async () => {
    const harness = await buildTools({ githubTaskMode: 'manage' });
    const result = (await harness.tool('create_github_issue').handler({ title: 'New', body: 'B', confirmed: true })) as {
      ok: boolean; number: number;
    };
    expect(result.ok).toBe(true);
    expect(result.number).toBe(7);
    expect(harness.store.createBoardIssue).toHaveBeenCalledWith(projectId, 'PVT_1', null, null, 'New', 'B');
    expect(harness.auditRows().some((r) => r.action === 'create_github_issue')).toBe(true);
  });

  it('update_github_issue refuses without confirmed, then updates when confirmed', async () => {
    const harness = await buildTools({ githubTaskMode: 'manage' });
    const refused = (await harness.tool('update_github_issue').handler({ number: 3, title: 'x' })) as { ok: boolean };
    expect(refused.ok).toBe(false);
    expect(harness.store.updateIssue).not.toHaveBeenCalled();

    const ok = (await harness.tool('update_github_issue').handler({ number: 3, title: 'x', confirmed: true })) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(harness.store.updateIssue).toHaveBeenCalledWith(projectId, 3, { title: 'x', body: undefined });
  });

  it('open_pull_request refuses without confirmed, then opens when confirmed', async () => {
    const harness = await buildTools({ githubTaskMode: 'manage' });
    const refused = (await harness.tool('open_pull_request').handler({ worktreeId: 'w1', title: 'PR' })) as { ok: boolean };
    expect(refused.ok).toBe(false);
    expect(harness.store.createPullRequest).not.toHaveBeenCalled();

    const ok = (await harness.tool('open_pull_request').handler({ worktreeId: 'w1', title: 'PR', confirmed: true })) as {
      ok: boolean; number: number;
    };
    expect(ok.ok).toBe(true);
    expect(ok.number).toBe(9);
    expect(harness.store.createPullRequest).toHaveBeenCalledWith(projectId, 'w1', { title: 'PR', body: undefined, draft: undefined, base: undefined });
  });

  it('move_board_item refuses without confirmed, then moves when confirmed', async () => {
    const harness = await buildTools({ githubTaskMode: 'manage' });
    const refused = (await harness.tool('move_board_item').handler({ itemId: 'i1', fieldId: 'f1' })) as { ok: boolean };
    expect(refused.ok).toBe(false);
    expect(harness.store.moveBoardItem).not.toHaveBeenCalled();

    const ok = (await harness.tool('move_board_item').handler({ itemId: 'i1', fieldId: 'f1', optionId: 'o1', confirmed: true })) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(harness.store.moveBoardItem).toHaveBeenCalledWith(projectId, 'PVT_1', 'i1', 'f1', 'o1');
  });

  it('wraps a GitHubCliError from a write into a structured result', async () => {
    const harness = await buildTools({ githubTaskMode: 'manage' });
    harness.store.createBoardIssue.mockRejectedValue(new GitHubCliError('scope', 'missing-scope'));
    const result = (await harness.tool('create_github_issue').handler({ title: 'New', confirmed: true })) as { ok: boolean; code: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing-scope');
  });
});
