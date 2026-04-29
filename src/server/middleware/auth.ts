import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDb } from '../../shared/db';
import { getUserById } from '../../shared/user-store';
import type { User } from '../../shared/types';

// Extend Express Request with user
declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionToken?: string;
    }
  }
}

// Ensure auth_sessions table exists
function ensureAuthTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
  `);
}

let tableReady = false;

export function createSession(userId: string): string {
  if (!tableReady) { ensureAuthTable(); tableReady = true; }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  getDb().prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

export function destroySession(token: string): void {
  if (!tableReady) { ensureAuthTable(); tableReady = true; }
  getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

export function destroyUserSessions(userId: string): void {
  if (!tableReady) { ensureAuthTable(); tableReady = true; }
  getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}

export function getUserFromToken(token: string): User | null {
  if (!tableReady) { ensureAuthTable(); tableReady = true; }
  const row = getDb().prepare(
    'SELECT user_id FROM auth_sessions WHERE token = ? AND expires_at > datetime(\'now\')'
  ).get(token) as { user_id: string } | undefined;
  if (!row) return null;
  return getUserById(row.user_id);
}

export const SESSION_COOKIE = 'clippy_session';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const user = getUserFromToken(token);
  if (!user) {
    res.clearCookie(SESSION_COOKIE);
    res.status(401).json({ error: 'Session expired' });
    return;
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
