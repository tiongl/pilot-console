import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A genuinely new Project Lead conversation must default to the project's
 * last-used model (sticky at the project level), while resume keeps the
 * session's own persisted model and non-lead / no-project sessions never write
 * a project default.
 */
describe('project-level sticky lead model', () => {
  let db: InstanceType<typeof Database>;
  let resumeConfigs: Array<Record<string, unknown>>;
  let bridge: typeof import('../shared/agent-bridge');

  beforeEach(async () => {
    vi.resetModules();
    resumeConfigs = [];

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        github_id TEXT,
        role TEXT
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        repo_path TEXT
      );
      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        worktree_path TEXT
      );
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
      CREATE TABLE project_autonomy_settings (
        project_id TEXT PRIMARY KEY,
        merge_mode TEXT NOT NULL DEFAULT 'advisory',
        intervention_mode TEXT NOT NULL DEFAULT 'flag_only',
        skill_install_mode TEXT NOT NULL DEFAULT 'suggest_only',
        github_task_mode TEXT NOT NULL DEFAULT 'off',
        lead_model TEXT,
        dnd INTEGER NOT NULL DEFAULT 0
      );
    `);

    let created = 0;
    const makeFakeSdk = () => ({
      sessionId: `created-session-${++created}`,
      on: () => () => {},
      getEvents: async () => [],
      setModel: async () => {},
      abort: async () => {},
      disconnect: async () => {},
    });

    class FakeCopilotClient {
      async start() {}
      async resumeSession(sessionId: string, config: Record<string, unknown>) {
        resumeConfigs.push(config);
        return { ...makeFakeSdk(), sessionId };
      }
      async createSession() {
        return makeFakeSdk();
      }
      async listSessions() {
        return [];
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

  function seedProject(id: string) {
    db.prepare('INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?)').run(id, id, null);
  }

  function leadModel(projectId: string): string | null {
    const row = db.prepare('SELECT lead_model FROM project_autonomy_settings WHERE project_id = ?')
      .get(projectId) as { lead_model?: string | null } | undefined;
    return row?.lead_model ?? null;
  }

  // ---- store helpers -------------------------------------------------------

  it('round-trips the project lead model and defaults to null', () => {
    seedProject('p1');
    expect(bridge.getProjectLeadModel('p1')).toBeNull();

    bridge.setProjectLeadModel('p1', 'gpt-6-sol');
    expect(bridge.getProjectLeadModel('p1')).toBe('gpt-6-sol');
  });

  it('preserves other autonomy columns when writing the lead model', () => {
    db.prepare(
      'INSERT INTO project_autonomy_settings (project_id, github_task_mode, skill_install_mode) VALUES (?, ?, ?)',
    ).run('p1', 'manage', 'approve_and_install');

    bridge.setProjectLeadModel('p1', 'claude-opus-5');

    const row = db.prepare(
      'SELECT github_task_mode, skill_install_mode, lead_model FROM project_autonomy_settings WHERE project_id = ?',
    ).get('p1') as { github_task_mode: string; skill_install_mode: string; lead_model: string };
    expect(row.github_task_mode).toBe('manage');
    expect(row.skill_install_mode).toBe('approve_and_install');
    expect(row.lead_model).toBe('claude-opus-5');
  });

  // ---- setAgentModel write-through ----------------------------------------

  it('setAgentModel on a project_lead session writes the project lead model', async () => {
    seedProject('p1');
    const session = await bridge.createAgentSession('u1', 'p1', null, 'auto', 'project_lead');

    await bridge.setAgentModel(session.sessionId, 'gpt-6-sol');

    expect(session.model).toBe('gpt-6-sol');
    expect(leadModel('p1')).toBe('gpt-6-sol');
  });

  it('setAgentModel on a worker (no-project) session does NOT write a project default', async () => {
    seedProject('p1');
    const session = await bridge.createAgentSession('u1', null, null, 'auto', 'agent');

    await bridge.setAgentModel(session.sessionId, 'gpt-6-sol');

    expect(session.model).toBe('gpt-6-sol');
    expect(leadModel('p1')).toBeNull();
  });

  // ---- create-fresh precedence --------------------------------------------

  it('create-fresh uses the project default when the param is the placeholder auto', async () => {
    seedProject('p1');
    bridge.setProjectLeadModel('p1', 'claude-opus-5');

    const session = await bridge.getOrCreatePersistentLeadSession('u1', 'p1', 'project_lead', 'auto');

    expect(session.model).toBe('claude-opus-5');
  });

  it('create-fresh falls back to DEFAULT_MODEL when no project default exists', async () => {
    seedProject('p1');

    const session = await bridge.getOrCreatePersistentLeadSession('u1', 'p1', 'project_lead', 'auto');

    expect(session.model).toBe('auto');
  });

  it('create-fresh lets a genuine explicit model win over the project default', async () => {
    seedProject('p1');
    bridge.setProjectLeadModel('p1', 'claude-opus-5');

    const session = await bridge.getOrCreatePersistentLeadSession('u1', 'p1', 'project_lead', 'gpt-6-sol');

    expect(session.model).toBe('gpt-6-sol');
  });

  // ---- resume path unchanged ----------------------------------------------

  it('resume restores the session\'s own persisted model, ignoring the project default', async () => {
    seedProject('p1');
    bridge.setProjectLeadModel('p1', 'claude-opus-5');
    db.prepare(
      'INSERT INTO cli_sessions (id, user_id, project_id, worktree_id, kind, agent_state, output_log) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'lead-session',
      'u1',
      'p1',
      null,
      'project_lead',
      JSON.stringify({ model: 'gpt-5.6-sol', mode: 'interactive', cwd: '/tmp', projectId: 'p1' }),
      '[{"kind":"user"}]',
    );

    const session = await bridge.getOrCreatePersistentLeadSession('u1', 'p1', 'project_lead', 'auto');

    expect(session.model).toBe('gpt-5.6-sol');
  });
});
