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
  assessCleanup: ReturnType<typeof vi.fn>;
  closeWorktreeMock: ReturnType<typeof vi.fn>;
  auditRows: () => Array<{ action: string; reasoning: string; subjectId: string | null }>;
  setWorktrees: (value: Array<{ id: string; name: string }>) => void;
  setLeadModel: (value: string | undefined) => void;
  todoRows: () => Array<{ id: string; text: string; done: number; parentId: string | null }>;
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
  let leadSessionModel: string | undefined;
  let delegationForWorktree: Record<string, unknown> | undefined;
  let mergeRequest: Record<string, unknown> | undefined;
  const updated: Array<[string, Record<string, unknown>]> = [];
  const executeMerge = vi.fn(async () => ({ pullRequestUrl: 'https://example/pr/1' }));
  let worktrees: Array<{ id: string; name: string }> = [];
  const assessCleanup = vi.fn(async (_p: string, worktreeId: string) => ({
    worktreeId,
    name: `name-${worktreeId}`,
    safe: true,
    blockers: [],
    merged: true,
    mergeEvidence: 'pull_request',
  }));
  const closeWorktreeMock = vi.fn(async (_p: string, worktreeId: string) => ({
    worktreeId,
    name: 'feature',
    branch: 'feature/login',
    closedSessions: ['sess-1'],
    closedDelegations: 1,
    assessment: { mergeEvidence: 'pull_request' },
  }));

  const createAgentSession = vi.fn(async (
    _userId?: string,
    _projectId?: string,
    _worktreeId?: string,
    model?: string,
  ) => ({ sessionId: 'worker-session-1', model: model ?? 'auto' }));
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
    getAgentSession: (id: string) =>
      id === 'lead-session' && leadSessionModel !== undefined
        ? { sessionId: id, model: leadSessionModel }
        : undefined,
  }));
  vi.doMock('../shared/project-memory-store', () => ({
    getOrBootstrapProjectMemory: () => ({ summary: '' }),
    refreshProjectMemory: vi.fn(),
  }));
  vi.doMock('../shared/project-store', () => ({
    createWorktree: () => ({ id: 'wt-new' }),
    listWorktrees: () => worktrees,
  }));
  vi.doMock('../shared/worktree-cleanup', () => ({
    assessWorktreeCleanup: assessCleanup,
    closeWorktree: closeWorktreeMock,
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
  db.exec(`
    CREATE TABLE project_todos (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id  TEXT REFERENCES project_todos(id) ON DELETE CASCADE,
      text       TEXT NOT NULL DEFAULT '',
      done       INTEGER NOT NULL DEFAULT 0,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.pragma('foreign_keys = ON');

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
    assessCleanup,
    closeWorktreeMock,
    auditRows: () =>
      db.prepare('SELECT action, reasoning, subject_id AS subjectId FROM project_audit_log').all() as Array<{
        action: string;
        reasoning: string;
        subjectId: string | null;
      }>,
    setWorktrees: (value: Array<{ id: string; name: string }>) => { worktrees = value; },
    setLeadModel: (value: string | undefined) => { leadSessionModel = value; },
    todoRows: () =>      db.prepare('SELECT id, text, done, parent_id AS parentId FROM project_todos ORDER BY position').all() as Array<{
        id: string;
        text: string;
        done: number;
        parentId: string | null;
      }>,
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

  // Tabs on the lead page are per-worktree, so nothing shrank that strip until
  // the lead could retire finished worktrees itself.
  /**
   * The lead reasons about the work, but the worker is what actually writes the
   * code. Creating workers with no model at all silently pinned them to `auto`
   * however carefully the user had chosen a model for the lead.
   */
  describe('worker model', () => {
    it('runs the worker on the model the lead is using', async () => {
      const h = await buildTools();
      h.setLeadModel('claude-opus-5');

      const result = (await h.tool('delegate_to_worker').handler({
        task: 'Fix the parser',
        title: 'Parser fix',
      })) as { model: string };

      expect(h.createAgentSession.mock.calls[0][3]).toBe('claude-opus-5');
      expect(result.model).toBe('claude-opus-5');
    });

    // Nothing here is worth failing a delegation over: falling back to the
    // runtime default is what happened before this existed.
    it('falls back to the default when the lead session is not live', async () => {
      const h = await buildTools();
      h.setLeadModel(undefined);

      const result = (await h.tool('delegate_to_worker').handler({
        task: 'Fix the parser',
        title: 'Parser fix',
      })) as { model: string };

      expect(h.createAgentSession.mock.calls[0][3]).toBeUndefined();
      expect(result.model).toBe('auto');
    });

    it('passes the lead model through when re-delegating to an existing worktree', async () => {
      const h = await buildTools();
      h.setLeadModel('gpt-5.6-sol');
      h.setWorktrees([{ id: 'wt-1', name: 'parser' }]);

      await h.tool('delegate_to_worker').handler({
        task: 'Fix the parser again',
        title: 'Parser fix',
        worktreeId: 'wt-1',
      });

      expect(h.createAgentSession.mock.calls[0][3]).toBe('gpt-5.6-sol');
    });
  });

  describe('close_worktree', () => {
    it('closes a worktree and reports what it retired', async () => {
      const h = await buildTools();

      const result = (await h.tool('close_worktree').handler({
        worktreeId: 'wt-1',
        reason: 'Login work merged in #42',
      })) as { ok: boolean; closedSessions: number; closedDelegations: number };

      expect(result.ok).toBe(true);
      expect(result.closedSessions).toBe(1);
      expect(result.closedDelegations).toBe(1);
      expect(h.closeWorktreeMock).toHaveBeenCalledWith(projectId, 'wt-1');
    });

    // The lead cannot see what uncommitted work it would destroy, so it must
    // never be able to override the safety checks.
    it('never forces past the safety checks', async () => {
      const h = await buildTools();

      await h.tool('close_worktree').handler({ worktreeId: 'wt-1', reason: 'tidy up' });

      const [, , options] = h.closeWorktreeMock.mock.calls[0];
      expect(options).toBeUndefined();
    });

    it('surfaces the refusal instead of swallowing it', async () => {
      const h = await buildTools();
      h.closeWorktreeMock.mockRejectedValueOnce(
        new Error('Worktree feature is not safe to close — uncommitted_changes: 2 files'),
      );

      await expect(
        h.tool('close_worktree').handler({ worktreeId: 'wt-1', reason: 'tidy up' }),
      ).rejects.toThrow('not safe to close');
    });

    it('does not record an audit entry for a close that failed', async () => {
      const h = await buildTools();
      h.closeWorktreeMock.mockRejectedValueOnce(new Error('nope'));

      await expect(
        h.tool('close_worktree').handler({ worktreeId: 'wt-1', reason: 'tidy up' }),
      ).rejects.toThrow();

      expect(h.auditRows()).toEqual([]);
    });

    it('records the reason against the worktree it closed', async () => {
      const h = await buildTools();

      await h.tool('close_worktree').handler({ worktreeId: 'wt-1', reason: 'merged in #42' });

      expect(h.auditRows()).toEqual([
        { action: 'close_worktree', reasoning: 'merged in #42', subjectId: 'wt-1' },
      ]);
    });
  });

  describe('list_closable_worktrees', () => {
    it('assesses every worktree in the project', async () => {
      const h = await buildTools();
      h.setWorktrees([
        { id: 'wt-1', name: 'login' },
        { id: 'wt-2', name: 'search' },
      ]);

      const result = (await h.tool('list_closable_worktrees').handler({})) as {
        worktrees: Array<{ worktreeId: string; safe: boolean }>;
      };

      expect(result.worktrees.map((w) => w.worktreeId)).toEqual(['wt-1', 'wt-2']);
      expect(result.worktrees.every((w) => w.safe)).toBe(true);
    });

    // One broken worktree must not hide the state of all the others.
    it('reports a worktree it could not assess without failing the rest', async () => {
      const h = await buildTools();
      h.setWorktrees([
        { id: 'wt-1', name: 'login' },
        { id: 'wt-2', name: 'search' },
      ]);
      h.assessCleanup.mockRejectedValueOnce(new Error('Worktree not found'));

      const result = (await h.tool('list_closable_worktrees').handler({})) as {
        worktrees: Array<{ worktreeId: string; safe: boolean; error?: string }>;
      };

      expect(result.worktrees[0]).toMatchObject({ safe: false, error: 'Worktree not found' });
      expect(result.worktrees[1]).toMatchObject({ worktreeId: 'wt-2', safe: true });
    });
  });

  /**
   * The lead's plan used to live only in its replies, so compaction eventually
   * lost it and the user had no way to see what it thought was outstanding.
   */
  describe('todo tools', () => {
    it('adds several items in one call, in order', async () => {
      const h = await buildTools();

      const result = (await h.tool('add_todos').handler({
        items: [{ text: 'Ship login' }, { text: 'Ship search' }],
      })) as { added: Array<{ id: string }> };

      expect(result.added).toHaveLength(2);
      expect(h.todoRows().map((r) => r.text)).toEqual(['Ship login', 'Ship search']);
    });

    it('nests an item under the one it was given', async () => {
      const h = await buildTools();
      const parent = (await h.tool('add_todos').handler({ items: [{ text: 'Ship login' }] })) as {
        added: Array<{ id: string }>;
      };

      await h.tool('add_todos').handler({
        items: [{ text: 'Write tests', parentId: parent.added[0].id }],
      });

      const child = h.todoRows().find((r) => r.text === 'Write tests');
      expect(child?.parentId).toBe(parent.added[0].id);
    });

    // A batch that half-lands is worse than one that fails: the lead cannot
    // tell which items it still owes without re-reading the whole list.
    it('names the item that was rejected', async () => {
      const h = await buildTools();

      await expect(
        h.tool('add_todos').handler({
          items: [{ text: 'Ship login' }, { text: 'Write tests', parentId: 'ghost' }],
        }),
      ).rejects.toThrow(/Item 2 \("Write tests"\)/);
    });

    it('refuses an empty batch', async () => {
      const h = await buildTools();

      await expect(h.tool('add_todos').handler({ items: [] })).rejects.toThrow(/at least one/);
    });

    it('ticks an item off', async () => {
      const h = await buildTools();
      const added = (await h.tool('add_todos').handler({ items: [{ text: 'Ship login' }] })) as {
        added: Array<{ id: string }>;
      };

      await h.tool('update_todo').handler({ todoId: added.added[0].id, done: true });

      expect(h.todoRows()[0].done).toBe(1);
    });

    it('tells the lead when the id it used is gone', async () => {
      const h = await buildTools();

      await expect(
        h.tool('update_todo').handler({ todoId: 'ghost', done: true }),
      ).rejects.toThrow(/No todo ghost/);
    });

    it('reads the list back as an indented outline', async () => {
      const h = await buildTools();
      const parent = (await h.tool('add_todos').handler({ items: [{ text: 'Ship login' }] })) as {
        added: Array<{ id: string }>;
      };
      await h.tool('add_todos').handler({
        items: [{ text: 'Write tests', parentId: parent.added[0].id }],
      });

      const result = (await h.tool('list_todos').handler({})) as {
        outline: string;
        total: number;
        remaining: number;
      };

      expect(result.outline).toContain('  - [ ] Write tests');
      expect(result).toMatchObject({ total: 2, remaining: 2 });
    });

    it('counts only unfinished items as remaining', async () => {
      const h = await buildTools();
      const added = (await h.tool('add_todos').handler({
        items: [{ text: 'Ship login' }, { text: 'Ship search' }],
      })) as { added: Array<{ id: string }> };
      await h.tool('update_todo').handler({ todoId: added.added[0].id, done: true });

      const result = (await h.tool('list_todos').handler({})) as { remaining: number };
      expect(result.remaining).toBe(1);
    });

    it('deletes an item and says how many sub-items went with it', async () => {
      const h = await buildTools();
      const parent = (await h.tool('add_todos').handler({ items: [{ text: 'Ship login' }] })) as {
        added: Array<{ id: string }>;
      };
      await h.tool('add_todos').handler({
        items: [{ text: 'Write tests', parentId: parent.added[0].id }],
      });

      const result = (await h.tool('delete_todo').handler({ todoId: parent.added[0].id })) as {
        alsoDeletedSubItems: number;
      };

      expect(result.alsoDeletedSubItems).toBe(1);
      expect(h.todoRows()).toEqual([]);
    });
  });
});
