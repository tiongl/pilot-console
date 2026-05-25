import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

function mapUser(row: any) {
  return {
    id: row.id,
    githubId: row.github_id,
    githubLogin: row.github_login,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

describe('auth middleware', () => {
  let db: Database.Database;
  let auth: typeof import('../server/middleware/auth');

  beforeEach(async () => {
    vi.resetModules();

    const betterSqlite3 = await import('better-sqlite3');
    const BetterSqlite3 = betterSqlite3.default;
    db = new BetterSqlite3(':memory:');

    db.exec(`
      CREATE TABLE auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        github_id TEXT UNIQUE NOT NULL,
        github_login TEXT,
        email TEXT,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    vi.doMock('../shared/db', () => ({
      getDb: () => db,
    }));

    vi.doMock('../shared/user-store', () => ({
      getUserById: vi.fn((userId: string) => {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
        return row ? mapUser(row) : null;
      }),
    }));

    auth = await import('../server/middleware/auth');
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  function insertUser(overrides: Partial<{
    id: string;
    github_id: string;
    github_login: string;
    email: string;
    display_name: string;
    role: string;
    created_at: string;
  }> = {}) {
    const user = {
      id: 'user-1',
      github_id: 'github-1',
      github_login: 'octocat',
      email: 'octocat@example.com',
      display_name: 'Octo Cat',
      role: 'user',
      created_at: '2025-01-01T00:00:00.000Z',
      ...overrides,
    };

    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.github_id,
      user.github_login,
      user.email,
      user.display_name,
      user.role,
      user.created_at,
    );

    return user;
  }

  it('createSession returns a hex token string', () => {
    const user = insertUser();

    const token = auth.createSession(user.id);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('getUserFromToken returns the user for a valid token and null for expired or invalid tokens', () => {
    const user = insertUser();
    const validToken = auth.createSession(user.id);

    db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      'expired-token',
      user.id,
      '2000-01-01T00:00:00.000Z',
    );

    expect(auth.getUserFromToken(validToken)).toMatchObject({
      id: user.id,
      githubId: user.github_id,
      role: 'user',
    });
    expect(auth.getUserFromToken('expired-token')).toBeNull();
    expect(auth.getUserFromToken('missing-token')).toBeNull();
  });

  it('destroySession removes a token', () => {
    const user = insertUser();
    const token = auth.createSession(user.id);

    auth.destroySession(token);

    const row = db.prepare('SELECT token FROM auth_sessions WHERE token = ?').get(token);
    expect(row).toBeUndefined();
  });

  it('destroyUserSessions removes all tokens for a user', () => {
    const user1 = insertUser();
    const user2 = insertUser({ id: 'user-2', github_id: 'github-2', github_login: 'hubot' });
    const token1 = auth.createSession(user1.id);
    const token2 = auth.createSession(user1.id);
    const otherToken = auth.createSession(user2.id);

    auth.destroyUserSessions(user1.id);

    const remaining = db.prepare('SELECT token, user_id FROM auth_sessions ORDER BY user_id').all() as any[];
    expect(remaining).toEqual([{ token: otherToken, user_id: user2.id }]);
    expect(remaining.find((row) => row.token === token1 || row.token === token2)).toBeUndefined();
  });

  it('requireAuth returns 401 when no cookie is present', () => {
    const req = { cookies: {} } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      clearCookie: vi.fn(),
    } as any;
    const next = vi.fn();

    auth.requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('requireAuth returns 401 and clears the cookie when the token is invalid', () => {
    const req = { cookies: { [auth.SESSION_COOKIE]: 'missing-token' } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      clearCookie: vi.fn(),
    } as any;
    const next = vi.fn();

    auth.requireAuth(req, res, next);

    expect(res.clearCookie).toHaveBeenCalledWith(auth.SESSION_COOKIE);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Session expired' });
    expect(next).not.toHaveBeenCalled();
  });

  it('requireAuth calls next and attaches the user when the token is valid', () => {
    const user = insertUser({ role: 'admin' });
    const token = auth.createSession(user.id);
    const req = { cookies: { [auth.SESSION_COOKIE]: token } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      clearCookie: vi.fn(),
    } as any;
    const next = vi.fn();

    auth.requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: user.id, role: 'admin' });
    expect(req.sessionToken).toBe(token);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('requireAdmin returns 403 when the user is not an admin', () => {
    const req = {
      user: {
        id: 'user-1',
        githubId: 'github-1',
        githubLogin: 'octocat',
        email: 'octocat@example.com',
        displayName: 'Octo Cat',
        role: 'user',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      clearCookie: vi.fn(),
    } as any;
    const next = vi.fn();

    auth.requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('requireAdmin calls next when the user is an admin', () => {
    const req = {
      user: {
        id: 'user-1',
        githubId: 'github-1',
        githubLogin: 'octocat',
        email: 'octocat@example.com',
        displayName: 'Octo Cat',
        role: 'admin',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      clearCookie: vi.fn(),
    } as any;
    const next = vi.fn();

    auth.requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
