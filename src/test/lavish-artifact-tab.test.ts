// @vitest-environment node
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

interface ToolLike {
  name?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

/**
 * Regression coverage for the "Lavish tab never appears" bug. Two guarantees:
 *  1. `GET /api/projects/:id/lavish` returns an artifact the moment it is created,
 *     so the Project Lead tab strip can render it.
 *  2. `open_artifact` writes the row (and audits) inside its try/catch, so a spawn
 *     failure still leaves a visible tab and a create failure is never silent.
 */
describe('lavish artifact tab wiring', () => {
  let db: InstanceType<typeof Database>;
  let emitSpy: ReturnType<typeof vi.fn>;

  function freshDb() {
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    d.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
        description TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE project_autonomy_settings (
        project_id TEXT PRIMARY KEY,
        merge_mode TEXT NOT NULL DEFAULT 'advisory',
        intervention_mode TEXT NOT NULL DEFAULT 'flag_only',
        skill_install_mode TEXT NOT NULL DEFAULT 'suggest_only',
        github_task_mode TEXT NOT NULL DEFAULT 'off',
        dnd INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE project_audit_log (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        action TEXT NOT NULL, reasoning TEXT, risk_level TEXT, subject_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE lavish_artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, html_path TEXT NOT NULL, session_key TEXT, host TEXT,
        port INTEGER, session_url TEXT, status TEXT NOT NULL DEFAULT 'starting',
        exit_code INTEGER, created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    d.prepare('INSERT INTO projects (id, name, repo_path) VALUES (?,?,?)').run('p1', 'Proj', '/tmp/p');
    d.prepare('INSERT INTO project_autonomy_settings (project_id) VALUES (?)').run('p1');
    return d;
  }

  beforeEach(() => {
    vi.resetModules();
    db = freshDb();
    emitSpy = vi.fn();
    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    vi.doMock('../shared/lavish-events', () => ({ emitArtifactsChanged: emitSpy }));
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('GET /api/projects/:id/lavish returns a just-created artifact', async () => {
    const store = await import('../shared/lavish-store');
    store.createArtifact({ projectId: 'p1', name: 'Architecture Plan', htmlPath: '/tmp/p/plan.html' });

    // Mount the exact endpoint contract from server/index.ts.
    const app = express();
    app.get('/api/projects/:id/lavish', (req, res) => {
      const projectId = String(req.params.id);
      const artifacts = store.listArtifactsByProject(projectId).map((a) => ({
        id: a.id,
        projectId: a.projectId,
        name: a.name,
        status: a.status,
        sessionKey: a.sessionKey,
        proxyPath: a.sessionKey ? `/api/lavish/${a.id}/session/${a.sessionKey}` : null,
        createdAt: a.createdAt,
      }));
      res.json({ artifacts });
    });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/p1/lavish`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { artifacts: Array<{ name: string; status: string }> };
      expect(body.artifacts).toHaveLength(1);
      expect(body.artifacts[0].name).toBe('Architecture Plan');
      expect(body.artifacts[0].status).toBe('starting');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  async function buildOpenArtifact(spawnImpl: ToolLike['handler']) {
    vi.doMock('../shared/lavish-runtime', () => ({ spawnLavishArtifact: spawnImpl }));
    const mod = await import('../shared/project-lead-tools');
    const built = mod.createProjectLeadTools('p1', 'user-1', () => 'lead-session') as unknown as ToolLike[];
    const open = built.find((t) => t.name === 'open_artifact');
    if (!open) throw new Error('open_artifact tool not registered');
    return open;
  }

  it('open_artifact still creates the row (visible tab) even when spawn fails', async () => {
    const open = await buildOpenArtifact(async () => {
      throw new Error('lavish-axi not installed');
    });

    await expect(open.handler({ htmlPath: '/tmp/p/plan.html', name: 'Plan' })).rejects.toThrow();

    const store = await import('../shared/lavish-store');
    // The row is created before spawn, so the tab is still reachable.
    expect(store.listArtifactsByProject('p1')).toHaveLength(1);
    // A spawn failure is audited at high risk (never silent).
    const audits = db
      .prepare("SELECT risk_level FROM project_audit_log WHERE action='open_artifact'")
      .all() as Array<{ risk_level: string }>;
    expect(audits).toEqual([{ risk_level: 'high' }]);
  });

  it('open_artifact succeeds end-to-end with a valid projectId: row + emit + endpoint', async () => {
    const store = await import('../shared/lavish-store');
    // A realistic spawn: the runtime attaches the live session, exactly as
    // spawnLavishArtifact does, then reports the artifact ready.
    const spawn = vi.fn(async (_u: string, a: { id: string }) => {
      store.updateArtifactSession(a.id, {
        sessionUrl: 'http://127.0.0.1:9000',
        host: '127.0.0.1',
        port: 9000,
        sessionKey: 'live-key',
      });
      store.updateArtifactStatus(a.id, 'ready', null);
      return { artifactId: a.id, status: 'ready' };
    });
    const open = await buildOpenArtifact(spawn as unknown as ToolLike['handler']);

    const result = (await open.handler({ htmlPath: '/tmp/p/plan.html', name: 'Architecture Plan' })) as {
      ok: boolean;
      status: string;
    };
    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);

    // The row is persisted under the real projectId (identical FK to project_servers,
    // which the working start_server proves is satisfied for a valid Lead projectId).
    const rows = store.listArtifactsByProject('p1');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ready');

    // A live push fired so the tab appears instantly (create + session + status).
    expect(emitSpy).toHaveBeenCalledWith('p1');
    expect(emitSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    // A success is audited at low risk.
    const audits = db
      .prepare("SELECT risk_level FROM project_audit_log WHERE action='open_artifact'")
      .all() as Array<{ risk_level: string }>;
    expect(audits).toEqual([{ risk_level: 'low' }]);

    // The endpoint serves the artifact with a proxyPath so the tab can render its iframe.
    const app = express();
    app.get('/api/projects/:id/lavish', (req, res) => {
      const artifacts = store.listArtifactsByProject(String(req.params.id)).map((a) => ({
        id: a.id,
        projectId: a.projectId,
        name: a.name,
        status: a.status,
        sessionKey: a.sessionKey,
        proxyPath: a.sessionKey ? `/api/lavish/${a.id}/session/${a.sessionKey}` : null,
        createdAt: a.createdAt,
      }));
      res.json({ artifacts });
    });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/p1/lavish`);
      const body = (await res.json()) as { artifacts: Array<{ name: string; status: string; proxyPath: string }> };
      expect(body.artifacts).toHaveLength(1);
      expect(body.artifacts[0].name).toBe('Architecture Plan');
      expect(body.artifacts[0].status).toBe('ready');
      expect(body.artifacts[0].proxyPath).toBe(`/api/lavish/${rows[0].id}/session/live-key`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('never masks the original create error, even when the failure audit also FK-throws — defense in depth', async () => {
    // Make createArtifact throw a DISTINCT sentinel so we can prove which error
    // surfaces. project_audit_log.project_id has the same FK as lavish_artifacts,
    // so for a since-deleted ('ghost') project the catch-block audit() INSERT also
    // throws "FOREIGN KEY constraint failed". Without the audit try/catch that FK
    // error would replace the sentinel; the fix guarantees the sentinel propagates.
    vi.doMock('../shared/lavish-store', () => ({
      createArtifact: () => {
        throw new Error('SENTINEL original create failure');
      },
      listArtifactsByProject: () => [],
    }));
    const spawn = vi.fn();
    vi.doMock('../shared/lavish-runtime', () => ({ spawnLavishArtifact: spawn }));

    const mod = await import('../shared/project-lead-tools');
    const built = mod.createProjectLeadTools('ghost-project', 'user-1', () => 'lead-session') as unknown as ToolLike[];
    const openGhost = built.find((t) => t.name === 'open_artifact')!;

    // The ORIGINAL create error surfaces — not the audit's FK error that masked it.
    await expect(openGhost.handler({ htmlPath: '/tmp/p/plan.html', name: 'Plan' })).rejects.toThrow(
      'SENTINEL original create failure',
    );
    expect(spawn).not.toHaveBeenCalled();

    // The audit INSERT FK-threw and was swallowed, so no audit row was written for
    // the ghost project — yet the original error still propagated above.
    const audits = db
      .prepare("SELECT id FROM project_audit_log WHERE project_id='ghost-project'")
      .all();
    expect(audits).toHaveLength(0);
  });
});
