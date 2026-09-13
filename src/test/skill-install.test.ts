import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

interface Harness {
  tool: (name: string) => ToolLike;
  installPlugin: ReturnType<typeof vi.fn>;
  uninstallPlugin: ReturnType<typeof vi.fn>;
  listInstalledPlugins: ReturnType<typeof vi.fn>;
  browsePlugins: ReturnType<typeof vi.fn>;
  writeToSession: ReturnType<typeof vi.fn>;
  auditRows: () => Array<{ action: string; reasoning: string }>;
}

const projectId = 'p1';

async function buildTools(
  options: { skillInstallMode?: string; sessionId?: string | undefined; writeResult?: boolean } = {},
): Promise<Harness> {
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
  db.prepare('INSERT INTO project_autonomy_settings (project_id, skill_install_mode) VALUES (?, ?)').run(
    projectId,
    options.skillInstallMode ?? 'suggest_only',
  );

  let idCounter = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `id-${++idCounter}` } as typeof crypto);

  const installPlugin = vi.fn((plugin: string, marketplace?: string) => `installed ${plugin}${marketplace ? '@' + marketplace : ''}`);
  const uninstallPlugin = vi.fn((plugin: string) => `uninstalled ${plugin}`);
  const listInstalledPlugins = vi.fn(() => [{ name: 'lavish', marketplace: 'axi', version: '1.0.0' }]);
  const browsePlugins = vi.fn(() => [{ name: 'lavish', description: 'interactive editing' }]);
  const writeToSession = vi.fn(() => options.writeResult ?? true);

  vi.doMock('../shared/db', () => ({ getDb: () => db }));
  vi.doMock('../shared/skill-catalog', () => ({
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    browsePlugins,
    pluginRef: (plugin: string, marketplace?: string) => (marketplace ? `${plugin}@${marketplace}` : plugin),
  }));
  vi.doMock('../shared/cli-bridge', () => ({ writeToSession }));

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
  const built = mod.createProjectLeadTools(
    projectId,
    'user-1',
    () => options.sessionId,
  ) as unknown as ToolLike[];
  const tools = new Map(built.map((t, index) => [t.name ?? `unnamed-${index}`, t]));

  return {
    tool: (name: string) => {
      const found = tools.get(name);
      if (!found) throw new Error(`tool ${name} not registered`);
      return found;
    },
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    browsePlugins,
    writeToSession,
    auditRows: () =>
      db.prepare('SELECT action, reasoning FROM project_audit_log ORDER BY created_at, id').all() as Array<{
        action: string;
        reasoning: string;
      }>,
  };
}

describe('browse_skills', () => {
  it('returns installed plugins and, when asked, browsable ones', async () => {
    const harness = await buildTools();
    const result = (await harness.tool('browse_skills').handler({ marketplace: 'axi' })) as {
      installed: unknown[];
      browsable: unknown[];
      marketplace: string | null;
    };
    expect(result.installed).toHaveLength(1);
    expect(result.browsable).toHaveLength(1);
    expect(result.marketplace).toBe('axi');
    expect(harness.browsePlugins).toHaveBeenCalledWith('axi');
  });

  it('omits browsable plugins when no marketplace is given', async () => {
    const harness = await buildTools();
    const result = (await harness.tool('browse_skills').handler({})) as { browsable: unknown[] };
    expect(result.browsable).toHaveLength(0);
    expect(harness.browsePlugins).not.toHaveBeenCalled();
  });
});

describe('install_skill gating', () => {
  it('refuses to install under suggest_only', async () => {
    const harness = await buildTools({ skillInstallMode: 'suggest_only', sessionId: 'lead-session' });
    const result = (await harness.tool('install_skill').handler({
      plugin: 'kunchenguid/lavish-axi',
      approved: true,
    })) as { installed: boolean; mode: string };

    expect(result.installed).toBe(false);
    expect(result.mode).toBe('suggest_only');
    expect(harness.installPlugin).not.toHaveBeenCalled();
    expect(harness.writeToSession).not.toHaveBeenCalled();
  });

  it('refuses to install under approve_and_install without approval', async () => {
    const harness = await buildTools({ skillInstallMode: 'approve_and_install', sessionId: 'lead-session' });
    const result = (await harness.tool('install_skill').handler({
      plugin: 'kunchenguid/lavish-axi',
    })) as { installed: boolean };

    expect(result.installed).toBe(false);
    expect(harness.installPlugin).not.toHaveBeenCalled();
    expect(harness.writeToSession).not.toHaveBeenCalled();
  });

  it('installs and loads into the live session once approved', async () => {
    const harness = await buildTools({ skillInstallMode: 'approve_and_install', sessionId: 'lead-session' });
    const result = (await harness.tool('install_skill').handler({
      plugin: 'kunchenguid/lavish-axi',
      approved: true,
    })) as { installed: boolean; sessionLoaded: boolean; plugin: string };

    expect(result.installed).toBe(true);
    expect(result.sessionLoaded).toBe(true);
    expect(result.plugin).toBe('kunchenguid/lavish-axi');
    expect(harness.installPlugin).toHaveBeenCalledWith('kunchenguid/lavish-axi', undefined);
    expect(harness.writeToSession).toHaveBeenCalledWith('lead-session', '/plugin install kunchenguid/lavish-axi\n');
    expect(harness.auditRows().some((row) => row.action === 'install_skill')).toBe(true);
  });

  it('installs a marketplace plugin using name@marketplace form', async () => {
    const harness = await buildTools({ skillInstallMode: 'approve_and_install', sessionId: 'lead-session' });
    await harness.tool('install_skill').handler({ plugin: 'foo', marketplace: 'bar', approved: true });
    expect(harness.installPlugin).toHaveBeenCalledWith('foo', 'bar');
    expect(harness.writeToSession).toHaveBeenCalledWith('lead-session', '/plugin install foo@bar\n');
  });

  it('still installs but notes a resume when no live session exists', async () => {
    const harness = await buildTools({ skillInstallMode: 'approve_and_install', sessionId: undefined });
    const result = (await harness.tool('install_skill').handler({
      plugin: 'kunchenguid/lavish-axi',
      approved: true,
    })) as { installed: boolean; sessionLoaded: boolean; note: string };

    expect(result.installed).toBe(true);
    expect(result.sessionLoaded).toBe(false);
    expect(harness.installPlugin).toHaveBeenCalled();
    expect(harness.writeToSession).not.toHaveBeenCalled();
    expect(result.note).toMatch(/resume/i);
  });

  it('reports sessionLoaded false when the session write fails (closed session)', async () => {
    const harness = await buildTools({
      skillInstallMode: 'approve_and_install',
      sessionId: 'lead-session',
      writeResult: false,
    });
    const result = (await harness.tool('install_skill').handler({
      plugin: 'kunchenguid/lavish-axi',
      approved: true,
    })) as { installed: boolean; sessionLoaded: boolean };

    expect(result.installed).toBe(true);
    expect(result.sessionLoaded).toBe(false);
    expect(harness.writeToSession).toHaveBeenCalled();
  });
});

describe('uninstall_skill', () => {
  it('does not load into the session when the persistent install fails', async () => {
    const harness = await buildTools({ skillInstallMode: 'approve_and_install', sessionId: 'lead-session' });
    harness.installPlugin.mockImplementation(() => {
      throw new Error('install failed');
    });

    await expect(
      harness.tool('install_skill').handler({
        plugin: 'kunchenguid/lavish-axi',
        approved: true,
      }),
    ).rejects.toThrow('install failed');

    expect(harness.writeToSession).not.toHaveBeenCalled();
    expect(harness.auditRows().some((row) => row.action === 'install_skill')).toBe(false);
  });

  it('uninstalls a plugin and audits it', async () => {
    const harness = await buildTools({ skillInstallMode: 'approve_and_install' });
    const result = (await harness.tool('uninstall_skill').handler({
      plugin: 'kunchenguid/lavish-axi',
    })) as { uninstalled: boolean };

    expect(result.uninstalled).toBe(true);
    expect(harness.uninstallPlugin).toHaveBeenCalledWith('kunchenguid/lavish-axi', undefined);
    expect(harness.auditRows().some((row) => row.action === 'uninstall_skill')).toBe(true);
  });
});
