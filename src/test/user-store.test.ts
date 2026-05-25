import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('user store', () => {
  let db: InstanceType<typeof Database>;
  let upsertUser: typeof import('../shared/user-store').upsertUser;
  let getUserByGitHubId: typeof import('../shared/user-store').getUserByGitHubId;
  let getUserById: typeof import('../shared/user-store').getUserById;
  let listUsers: typeof import('../shared/user-store').listUsers;
  let updateUserRole: typeof import('../shared/user-store').updateUserRole;
  let deleteUser: typeof import('../shared/user-store').deleteUser;

  beforeEach(async () => {
    vi.resetModules();

    db = new Database(':memory:');
    db.exec(`
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

    let idCounter = 0;
    vi.doMock('../shared/db', () => ({
      getDb: () => db,
    }));
    vi.stubGlobal('crypto', {
      randomUUID: () => `user-${++idCounter}`,
    } as typeof crypto);

    const mod = await import('../shared/user-store');
    upsertUser = mod.upsertUser;
    getUserByGitHubId = mod.getUserByGitHubId;
    getUserById = mod.getUserById;
    listUsers = mod.listUsers;
    updateUserRole = mod.updateUserRole;
    deleteUser = mod.deleteUser;
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates a new user and makes the first user an admin', () => {
    const user = upsertUser('1001', 'alice', 'alice@example.com', 'Alice');

    expect(user).toMatchObject({
      id: 'user-1',
      githubId: '1001',
      githubLogin: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'admin',
    });
    expect(getUserByGitHubId('1001')).toMatchObject({ id: 'user-1', role: 'admin' });
  });

  it('updates an existing user found by GitHub id', () => {
    const created = upsertUser('1001', 'alice', 'alice@example.com', 'Alice');
    const updated = upsertUser('1001', 'alice-renamed', 'new@example.com', 'Alice Updated');

    expect(updated.id).toBe(created.id);
    expect(updated.githubLogin).toBe('alice-renamed');
    expect(updated.email).toBe('new@example.com');
    expect(updated.displayName).toBe('Alice Updated');
    expect(listUsers()).toHaveLength(1);
  });

  it('gets users by GitHub id or internal id and returns null when missing', () => {
    const created = upsertUser('1001', 'alice', 'alice@example.com', 'Alice');

    expect(getUserByGitHubId('1001')).toMatchObject({ id: created.id, githubLogin: 'alice' });
    expect(getUserByGitHubId('missing')).toBeNull();
    expect(getUserById(created.id)).toMatchObject({ githubId: '1001' });
    expect(getUserById('missing')).toBeNull();
  });

  it('lists all users', () => {
    const first = upsertUser('1001', 'alice', 'alice@example.com', 'Alice');
    const second = upsertUser('1002', 'bob', 'bob@example.com', 'Bob');

    const users = listUsers();

    expect(users).toHaveLength(2);
    expect(users.map(user => user.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('updates a user role', () => {
    const created = upsertUser('1001', 'alice', 'alice@example.com', 'Alice');

    updateUserRole(created.id, 'user');

    expect(getUserById(created.id)).toMatchObject({ role: 'user' });
  });

  it('deletes a user', () => {
    const created = upsertUser('1001', 'alice', 'alice@example.com', 'Alice');

    deleteUser(created.id);

    expect(getUserById(created.id)).toBeNull();
  });
});
