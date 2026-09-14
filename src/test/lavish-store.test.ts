import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('lavish store', () => {
  let db: InstanceType<typeof Database>;
  let store: typeof import('../shared/lavish-store');

  beforeEach(async () => {
    vi.resetModules();

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE lavish_artifacts (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        name            TEXT NOT NULL,
        html_path       TEXT NOT NULL,
        session_key     TEXT,
        host            TEXT,
        port            INTEGER,
        session_url     TEXT,
        status          TEXT NOT NULL DEFAULT 'starting',
        exit_code       INTEGER,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      );
    `);

    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    store = await import('../shared/lavish-store');
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('creates an artifact in the starting state', () => {
    const a = store.createArtifact({ projectId: 'p1', name: 'Plan', htmlPath: '/tmp/plan.html' });
    expect(a.id).toBeTruthy();
    expect(a.status).toBe('starting');
    expect(a.sessionKey).toBeNull();
    expect(a.port).toBeNull();
    expect(store.getArtifactById(a.id)?.name).toBe('Plan');
  });

  it('persists the parsed session URL and flips status to ready', () => {
    const a = store.createArtifact({ projectId: 'p1', name: 'Plan', htmlPath: '/tmp/plan.html' });
    const updated = store.updateArtifactSession(a.id, {
      sessionUrl: 'http://host:4387/session/abc123',
      host: 'host',
      port: 4387,
      sessionKey: 'abc123',
    });
    expect(updated.status).toBe('ready');
    expect(updated.port).toBe(4387);
    expect(updated.sessionKey).toBe('abc123');
    expect(updated.sessionUrl).toBe('http://host:4387/session/abc123');
  });

  it('lists artifacts by project and updates status', () => {
    const a = store.createArtifact({ projectId: 'p1', name: 'A', htmlPath: '/tmp/a.html' });
    store.createArtifact({ projectId: 'p2', name: 'B', htmlPath: '/tmp/b.html' });
    expect(store.listArtifactsByProject('p1')).toHaveLength(1);

    store.updateArtifactStatus(a.id, 'stopped', 0);
    expect(store.getArtifactById(a.id)?.status).toBe('stopped');
    expect(store.getArtifactById(a.id)?.exitCode).toBe(0);
  });

  it('deletes an artifact', () => {
    const a = store.createArtifact({ projectId: 'p1', name: 'A', htmlPath: '/tmp/a.html' });
    store.deleteArtifact(a.id);
    expect(store.getArtifactById(a.id)).toBeNull();
  });
});
