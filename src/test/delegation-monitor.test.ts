import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LeadMessage {
  userId: string;
  projectId: string;
  message: string;
}

describe('delegation stall monitor', () => {
  let db: InstanceType<typeof Database>;
  let notified: LeadMessage[];
  let liveSessions: Map<string, { alive: boolean; status: string }>;
  let resumable: Map<string, { alive: boolean; status: string } | undefined>;
  let pendingReviews: Set<string>;
  let monitor: typeof import('../server/delegation-monitor');

  const projectId = 'p1';
  const userId = 'u1';

  function seed(opts: {
    id: string;
    worktreeId: string;
    status: string;
    updatedAt: string;
    sessionId?: string | null;
  }) {
    db.prepare(
      `INSERT INTO delegations (id, project_id, worktree_id, session_id, title, task, status, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      projectId,
      opts.worktreeId,
      opts.sessionId === undefined ? `sess-${opts.id}` : opts.sessionId,
      `Title ${opts.id}`,
      'do the thing',
      opts.status,
      opts.updatedAt,
      opts.updatedAt,
    );
    if (opts.sessionId !== null) {
      db.prepare('INSERT OR IGNORE INTO cli_sessions (id, user_id) VALUES (?, ?)').run(
        opts.sessionId ?? `sess-${opts.id}`,
        userId,
      );
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    notified = [];
    liveSessions = new Map();
    resumable = new Map();
    pendingReviews = new Set();

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        session_id TEXT,
        title TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        unread INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE worktrees (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE cli_sessions (id TEXT PRIMARY KEY, user_id TEXT);
    `);

    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    vi.doMock('../shared/agent-bridge', () => ({
      findLiveWorktreeAgent: (_p: string, worktreeId: string) => liveSessions.get(worktreeId),
      resumeAgentSession: async (_u: string, sessionId: string) => resumable.get(sessionId),
    }));
    vi.doMock('../shared/delegation-runtime', () => ({
      hasPendingPlanReview: (worktreeId: string) => pendingReviews.has(worktreeId),
      notifyProjectLead: async (u: string, p: string, message: string) => {
        notified.push({ userId: u, projectId: p, message });
      },
    }));

    monitor = await import('../server/delegation-monitor');
  });

  // SQLite stores UTC with no zone marker. Reading it as local time shifts it
  // by the machine's offset, which would hide (or invent) every stall.
  it('reads SQLite UTC timestamps as UTC, not local time', () => {
    expect(monitor.parseDbTimestamp('2024-05-01 10:20:30')).toBe(Date.parse('2024-05-01T10:20:30Z'));
    expect(monitor.parseDbTimestamp('2024-05-01T10:20:30Z')).toBe(Date.parse('2024-05-01T10:20:30Z'));
    expect(monitor.parseDbTimestamp(null)).toBeNull();
    expect(monitor.parseDbTimestamp('not a date')).toBeNull();
  });

  it('only considers a delegation stale past the grace period', () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    expect(monitor.isStale('2024-05-01 11:59:00', now)).toBe(false);
    expect(monitor.isStale('2024-05-01 11:00:00', now)).toBe(true);
    // An unreadable timestamp is not evidence of a stall.
    expect(monitor.isStale('nonsense', now)).toBe(false);
  });

  it('flags a stale worker whose session is gone and tells the lead how to retry', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'working', updatedAt: '2024-05-01 11:00:00' });

    expect(await monitor.sweepStalledDelegations(now)).toBe(1);

    const row = db.prepare('SELECT status, note, unread FROM delegations WHERE id = ?').get('d1') as {
      status: string;
      note: string;
      unread: number;
    };
    expect(row.status).toBe('blocked');
    expect(row.unread).toBe(1);
    expect(notified).toHaveLength(1);
    expect(notified[0].userId).toBe(userId);
    expect(notified[0].message).toContain('worker stopped');
    expect(notified[0].message).toContain('cancel_worker');
    expect(notified[0].message).toContain('wt1');
  });

  it('leaves a worker alone while it is still busy', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'working', updatedAt: '2024-05-01 11:00:00' });
    liveSessions.set('wt1', { alive: true, status: 'busy' });

    expect(await monitor.sweepStalledDelegations(now)).toBe(0);
    expect(notified).toHaveLength(0);
  });

  // The runtime outlives a server restart, so an absent session must be
  // resumed before it is called dead.
  it('resumes a missing session before judging it, and spares one that is working', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'working', updatedAt: '2024-05-01 11:00:00' });
    resumable.set('sess-d1', { alive: true, status: 'busy' });

    expect(await monitor.sweepStalledDelegations(now)).toBe(0);
    expect(db.prepare('SELECT status FROM delegations WHERE id = ?').get('d1')).toMatchObject({
      status: 'working',
    });
  });

  it('flags a session that resumes but has gone idle mid-task', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'working', updatedAt: '2024-05-01 11:00:00' });
    resumable.set('sess-d1', { alive: true, status: 'idle' });

    expect(await monitor.sweepStalledDelegations(now)).toBe(1);
  });

  it('does not touch a recently active worker', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'working', updatedAt: '2024-05-01 11:58:00' });

    expect(await monitor.sweepStalledDelegations(now)).toBe(0);
  });

  it('ignores delegations that already finished or were closed out', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'done', updatedAt: '2024-05-01 11:00:00' });
    seed({ id: 'd2', worktreeId: 'wt2', status: 'cancelled', updatedAt: '2024-05-01 11:00:00' });
    seed({ id: 'd3', worktreeId: 'wt3', status: 'blocked', updatedAt: '2024-05-01 11:00:00' });

    expect(await monitor.sweepStalledDelegations(now)).toBe(0);
    expect(notified).toHaveLength(0);
  });

  // Waiting on the lead is the system working as designed.
  it('spares a worker that is genuinely waiting for a plan review', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'awaiting_plan_review', updatedAt: '2024-05-01 11:00:00' });
    pendingReviews.add('wt1');

    expect(await monitor.sweepStalledDelegations(now)).toBe(0);
  });

  // ...but a review that no longer exists means the worker is stuck forever.
  it('flags a worker awaiting a review that no longer exists', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'awaiting_plan_review', updatedAt: '2024-05-01 11:00:00' });

    expect(await monitor.sweepStalledDelegations(now)).toBe(1);
  });

  it('flags a stale worker even when there is no owner to notify', async () => {
    const now = Date.parse('2024-05-01T12:00:00Z');
    seed({ id: 'd1', worktreeId: 'wt1', status: 'working', updatedAt: '2024-05-01 11:00:00', sessionId: null });

    expect(await monitor.sweepStalledDelegations(now)).toBe(1);
    expect(notified).toHaveLength(0);
  });
});
