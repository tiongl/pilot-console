import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The runtime keeps whatever system prompt a session was created with. Every
 * durable Chief of Staff and Project Lead conversation therefore kept its
 * original instructions for ever, so guidance added later — how to use
 * ask_user, the todo list, worktree cleanup — reached only brand-new sessions
 * and never the ones the user actually works in.
 */
describe('system instructions on resume', () => {
  let db: InstanceType<typeof Database>;
  let resumeConfigs: Array<Record<string, unknown>>;
  let bridge: typeof import('../shared/agent-bridge');

  beforeEach(async () => {
    vi.resetModules();
    resumeConfigs = [];

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cli_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT,
        worktree_id TEXT,
        kind TEXT,
        copilot_session_id TEXT,
        agent_state TEXT,
        output_log TEXT,
        started_at TEXT,
        ended_at TEXT
      );
    `);

    const fakeSdk = {
      sessionId: 'lead-session',
      on: () => () => {},
      getEvents: async () => [],
      setModel: async () => {},
      disconnect: async () => {},
    };

    class FakeCopilotClient {
      async start() {}
      async resumeSession(sessionId: string, config: Record<string, unknown>) {
        resumeConfigs.push(config);
        return { ...fakeSdk, sessionId };
      }
      async createSession() {
        return fakeSdk;
      }
    }

    vi.doMock('@github/copilot-sdk', () => ({
      CopilotClient: FakeCopilotClient,
      RuntimeConnection: { forUri: () => ({}) },
      defineTool: (name: string, config: Record<string, unknown>) => ({ name, ...config }),
    }));
    // No daemon in tests: the bridge falls back to an in-process runtime, which
    // is the same FakeCopilotClient.
    vi.doMock('../daemon/client', () => ({
      getDaemonClient: () => ({ runtimeInfo: async () => { throw new Error('no daemon'); } }),
    }));
    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    vi.doMock('../shared/project-memory-store', () => ({
      getOrBootstrapProjectMemory: () => ({ summary: 'Memory summary for tests' }),
      refreshProjectMemory: vi.fn(),
    }));

    bridge = await import('../shared/agent-bridge');
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function seedSession(kind: string, projectId: string | null, worktreeId: string | null) {
    db.prepare(
      'INSERT INTO cli_sessions (id, user_id, project_id, worktree_id, kind, agent_state, output_log) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'lead-session',
      'u1',
      projectId,
      worktreeId,
      kind,
      JSON.stringify({ model: 'auto', mode: 'interactive', cwd: '/tmp', projectId, worktreeId }),
      '[]',
    );
  }

  it('re-applies the lead instructions when an existing conversation is resumed', async () => {
    seedSession('project_lead', 'p1', null);

    await bridge.resumeAgentSession('u1', 'lead-session');

    const content = String(
      (resumeConfigs[0]?.systemMessage as { content?: string } | undefined)?.content ?? '',
    );
    expect(content).toContain('You are the Project Lead');
    expect(content).toContain('close_worktree');
    expect(content).toContain('list_todos');
  });

  it('includes the bootstrapped project memory on resume, not just on create', async () => {
    seedSession('project_lead', 'p1', null);

    await bridge.resumeAgentSession('u1', 'lead-session');

    const content = String(
      (resumeConfigs[0]?.systemMessage as { content?: string } | undefined)?.content ?? '',
    );
    expect(content).toContain('Memory summary for tests');
  });

  // Worker sessions are scoped to a worktree and get the digest guidance; the
  // lead's coordination instructions would be nonsense for them.
  it('gives a resumed worktree worker the digest instructions and not the lead ones', async () => {
    seedSession('agent', 'p1', 'wt-1');

    await bridge.resumeAgentSession('u1', 'lead-session');

    const content = String(
      (resumeConfigs[0]?.systemMessage as { content?: string } | undefined)?.content ?? '',
    );
    expect(content).toContain('update_digest');
    expect(content).not.toContain('You are the Project Lead');
  });

  it('gives every resumed session the ask_user guidance', async () => {
    seedSession('agent', null, null);

    await bridge.resumeAgentSession('u1', 'lead-session');

    const content = String(
      (resumeConfigs[0]?.systemMessage as { content?: string } | undefined)?.content ?? '',
    );
    expect(content).toContain('ask_user');
    // The user's most common complaint is being made to type "go ahead", so
    // the guidance has to name go-ahead checks specifically.
    expect(content).toMatch(/shall I proceed/i);
    expect(content).toMatch(/go ahead/i);
  });

  it('appends rather than replacing the runtime\'s own prompt', async () => {
    seedSession('project_lead', 'p1', null);

    await bridge.resumeAgentSession('u1', 'lead-session');

    expect((resumeConfigs[0]?.systemMessage as { mode?: string }).mode).toBe('append');
  });
});
