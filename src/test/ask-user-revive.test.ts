import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ask_user` parks the agent's turn on a promise held in this process. A server
 * restart throws that promise away, so the transcript keeps showing the call as
 * running while the browser has no card to click: the user sees an ask_user
 * tool call and no question, and the turn can never finish.
 */
describe('reviving an ask_user question orphaned by a restart', () => {
  let db: InstanceType<typeof Database>;
  let sent: string[];
  let bridge: typeof import('../shared/agent-bridge');

  beforeEach(async () => {
    vi.resetModules();
    sent = [];

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
      // An empty replay keeps the stored transcript, which is where the stuck
      // tool call lives.
      getEvents: async () => [],
      send: async ({ prompt }: { prompt: string }) => {
        sent.push(prompt);
      },
      setModel: async () => {},
      disconnect: async () => {},
    };

    class FakeCopilotClient {
      async start() {}
      async resumeSession(sessionId: string) {
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

  function seedSession(transcript: unknown[]) {
    db.prepare(
      'INSERT INTO cli_sessions (id, user_id, project_id, worktree_id, kind, agent_state, output_log) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'lead-session',
      'u1',
      'p1',
      null,
      'project_lead',
      JSON.stringify({ model: 'auto', mode: 'interactive', cwd: '/tmp', projectId: 'p1' }),
      JSON.stringify(transcript),
    );
  }

  const stuckAsk = {
    kind: 'tool',
    id: 'tool:1',
    ts: 1,
    toolCallId: 'c1',
    toolName: 'ask_user',
    status: 'running',
    args: {
      question: 'Should I merge the probe now?',
      detail: 'W53 is still open.',
      options: ['Merge now', 'Wait for W53'],
    },
  };

  it('re-asks the question and marks the dead tool call as interrupted', async () => {
    seedSession([stuckAsk]);

    const session = await bridge.resumeAgentSession('u1', 'lead-session');

    const pending = bridge.pendingMessagesForSession(session!);
    const question = pending.find((m) => m.type === 'ask_user_request');
    expect(question).toBeTruthy();
    expect(question).toMatchObject({
      question: 'Should I merge the probe now?',
      detail: 'W53 is still open.',
      options: ['Merge now', 'Wait for W53'],
    });

    const tool = session!.transcript.find((e) => e.kind === 'tool');
    expect(tool).toMatchObject({ status: 'error' });
  });

  // The tool's promise is gone, so the answer cannot be returned as a tool
  // result. Delivering it as an ordinary message is what gets the agent moving.
  it('delivers the answer to the agent as a normal message', async () => {
    seedSession([stuckAsk]);

    const session = await bridge.resumeAgentSession('u1', 'lead-session');
    const pending = bridge.pendingMessagesForSession(session!);
    const question = pending.find((m) => m.type === 'ask_user_request') as { requestId: string };

    bridge.resolveAskUser(session!, question.requestId, 'Merge now');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual(['Merge now']);
  });

  it('leaves a session with no stuck question alone', async () => {
    seedSession([{ ...stuckAsk, status: 'success', output: 'Merge now' }]);

    const session = await bridge.resumeAgentSession('u1', 'lead-session');

    expect(bridge.pendingMessagesForSession(session!)).toEqual([]);
  });

  it('re-asks only the most recent question when a restart stranded several', async () => {
    seedSession([
      { ...stuckAsk, id: 'tool:1', toolCallId: 'c1', args: { question: 'Older question?' } },
      { ...stuckAsk, id: 'tool:2', toolCallId: 'c2', args: { question: 'Newest question?' } },
    ]);

    const session = await bridge.resumeAgentSession('u1', 'lead-session');

    const questions = bridge
      .pendingMessagesForSession(session!)
      .filter((m) => m.type === 'ask_user_request');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ question: 'Newest question?' });
    // Both dead calls still have to stop looking like they are running.
    expect(session!.transcript.every((e) => e.kind !== 'tool' || e.status === 'error')).toBe(true);
  });
});
