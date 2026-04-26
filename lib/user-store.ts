import { getDb } from './app-db';
import type { User } from '@/types';

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    githubId: row.github_id as string,
    githubLogin: (row.github_login as string) ?? null,
    email: (row.email as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    role: row.role as 'admin' | 'user',
    createdAt: row.created_at as string,
  };
}

export function upsertUser(
  githubId: string,
  githubLogin: string | null,
  email: string | null,
  displayName: string | null,
): User {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as Record<string, unknown> | undefined;

  if (existing) {
    db.prepare('UPDATE users SET github_login = ?, email = ?, display_name = ? WHERE github_id = ?')
      .run(githubLogin, email, displayName, githubId);
    return rowToUser({ ...existing, github_login: githubLogin, email, display_name: displayName });
  }

  // First user ever becomes admin automatically
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  const role = count === 0 ? 'admin' : 'user';
  const id = crypto.randomUUID();

  db.prepare('INSERT INTO users (id, github_id, github_login, email, display_name, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, githubId, githubLogin, email, displayName, role);
  return { id, githubId, githubLogin, email, displayName, role, createdAt: new Date().toISOString() };
}

export function getUserByGitHubId(githubId: string): User | null {
  const row = getDb().prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function getUserById(id: string): User | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function listUsers(): User[] {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToUser);
}

export function updateUserRole(id: string, role: 'admin' | 'user'): void {
  getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function deleteUser(id: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}
