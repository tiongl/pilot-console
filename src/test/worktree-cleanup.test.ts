import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A worktree may only be removed once its work is safely elsewhere. These
 * tests drive the git/gh calls directly so each unsafe condition can be
 * reproduced exactly.
 */
describe('worktree cleanup', () => {
  let db: InstanceType<typeof Database>;
  let assessWorktreeCleanup: typeof import('../shared/worktree-cleanup').assessWorktreeCleanup;
  let closeWorktree: typeof import('../shared/worktree-cleanup').closeWorktree;

  /** Command handlers, matched on the joined argument list. */
  let responses: Array<{ match: RegExp; stdout?: string; fail?: string }>;
  let calls: string[];
  let dirExists: boolean;
  let liveAgent: { sessionId: string; status: string } | null;
  let endedWorktrees: Array<[string, string]>;

  const PROJECT = 'proj-1';
  const WORKTREE = 'wt-1';

  function seed() {
    db.prepare("INSERT INTO projects (id, name, repo_path) VALUES (?, 'Demo', 'C:/repo')").run(PROJECT);
    db.prepare(`
      INSERT INTO worktrees (id, project_id, name, branch, worktree_path, is_managed)
      VALUES (?, ?, 'feature', 'feature/login', 'C:/repo/.worktrees/feature', 1)
    `).run(WORKTREE, PROJECT);
    db.prepare(`
      INSERT INTO delegations (id, project_id, worktree_id, session_id, title, task, status)
      VALUES ('d1', ?, ?, 'sess-1', 'Login', 'Build login', 'done')
    `).run(PROJECT, WORKTREE);
  }

  beforeEach(async () => {
    vi.resetModules();
    responses = [];
    calls = [];
    dirExists = true;
    liveAgent = null;
    endedWorktrees = [];

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
        description TEXT, pinned INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE, is_managed INTEGER NOT NULL DEFAULT 1,
        type TEXT NOT NULL DEFAULT 'worktree', issue_number INTEGER, seed_prompt TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, session_id TEXT,
        title TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planning',
        note TEXT, unread INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE merge_requests (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal', requested_at TEXT, resolved_at TEXT,
        summary TEXT, lead_note TEXT
      );
      CREATE TABLE merge_locks (
        project_id TEXT PRIMARY KEY, held_by_worktree_id TEXT, held_since TEXT, expires_at TEXT
      );
    `);
    seed();

    vi.doMock('../shared/db', () => ({ getDb: () => db }));

    const existsSync = vi.fn(() => dirExists);
    vi.doMock('fs', () => {
      const api = { existsSync, statSync: () => ({ isDirectory: () => true }), realpathSync: (v: string) => v };
      return { default: api, ...api };
    });

    // Callback-style so `promisify` produces the { stdout, stderr } shape the
    // real execFile does.
    const execFile = (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
    ) => {
      const line = `${cmd} ${args.join(' ')}`;
      calls.push(line);
      const hit = responses.find((r) => r.match.test(line));
      if (hit?.fail) cb(new Error(hit.fail));
      else cb(null, { stdout: hit?.stdout ?? '', stderr: '' });
    };
    const execFileSync = vi.fn();
    vi.doMock('child_process', () => ({ default: { execFile, execFileSync }, execFile, execFileSync }));

    vi.doMock('../shared/agent-bridge', () => ({
      findLiveWorktreeAgent: () => liveAgent,
      endWorktreeAgentSessions: async (p: string, w: string) => {
        endedWorktrees.push([p, w]);
        return ['sess-1'];
      },
    }));

    const mod = await import('../shared/worktree-cleanup');
    assessWorktreeCleanup = mod.assessWorktreeCleanup;
    closeWorktree = mod.closeWorktree;
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  /** Clean tree, and GitHub reports the branch's PR as merged. */
  function mergedViaPullRequest() {
    responses.push({ match: /git status --porcelain/, stdout: '' });
    responses.push({ match: /gh pr list/, stdout: JSON.stringify([{ state: 'MERGED' }]) });
  }

  it('clears a worktree whose pull request has been merged', async () => {
    mergedViaPullRequest();
    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.mergeEvidence).toBe('pull_request');
    expect(result.blockers).toEqual([]);
  });

  // Squash merges rewrite history, so the original commits never become
  // ancestors of main. Trusting ancestry alone would refuse to clean up
  // every worktree this project ever merges.
  it('trusts a merged pull request over ancestry for squash merges', async () => {
    responses.push({ match: /git status --porcelain/, stdout: '' });
    responses.push({ match: /gh pr list/, stdout: JSON.stringify([{ state: 'MERGED' }]) });
    responses.push({ match: /rev-list --count/, stdout: '7' });

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(true);
    expect(calls.some((c) => c.includes('rev-list'))).toBe(false);
  });

  it('refuses a worktree with uncommitted changes', async () => {
    responses.push({ match: /git status --porcelain/, stdout: ' M src/app.ts\n?? notes.md' });
    responses.push({ match: /gh pr list/, stdout: JSON.stringify([{ state: 'MERGED' }]) });

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(false);
    expect(result.blockers[0].code).toBe('uncommitted_changes');
    expect(result.blockers[0].detail).toContain('src/app.ts');
  });

  it('refuses a branch with commits that are not on the base branch', async () => {
    responses.push({ match: /git status --porcelain/, stdout: '' });
    responses.push({ match: /gh pr list/, stdout: '[]' });
    responses.push({ match: /symbolic-ref/, stdout: 'origin/main' });
    responses.push({ match: /rev-list --count/, stdout: '3' });

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('unmerged_commits');
    expect(result.blockers[0].detail).toContain('3 commit');
  });

  it('accepts a branch merged locally, without a pull request', async () => {
    responses.push({ match: /git status --porcelain/, stdout: '' });
    responses.push({ match: /gh pr list/, stdout: '[]' });
    responses.push({ match: /symbolic-ref/, stdout: 'origin/main' });
    responses.push({ match: /rev-list --count/, stdout: '0' });

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(true);
    expect(result.mergeEvidence).toBe('ancestry');
    expect(result.baseBranch).toBe('main');
  });

  // Comparing against a stale origin/main would report merged work as unmerged.
  it('refreshes the base branch before comparing', async () => {
    responses.push({ match: /git status --porcelain/, stdout: '' });
    responses.push({ match: /gh pr list/, stdout: '[]' });
    responses.push({ match: /symbolic-ref/, stdout: 'origin/main' });
    responses.push({ match: /rev-list --count/, stdout: '0' });

    await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(calls).toContain('git fetch origin main --quiet');
  });

  it('falls back to master when origin/HEAD is not set', async () => {
    responses.push({ match: /git status --porcelain/, stdout: '' });
    responses.push({ match: /gh pr list/, stdout: '[]' });
    responses.push({ match: /symbolic-ref/, fail: 'no symbolic ref' });
    responses.push({ match: /rev-parse --verify --quiet refs\/remotes\/origin\/main/, fail: 'unknown revision' });
    responses.push({ match: /rev-parse --verify --quiet refs\/remotes\/origin\/master/, stdout: 'abc123' });
    responses.push({ match: /rev-list --count/, stdout: '0' });

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.baseBranch).toBe('master');
    expect(result.safe).toBe(true);
  });

  it('refuses while a worker is mid-turn', async () => {
    mergedViaPullRequest();
    liveAgent = { sessionId: 'sess-1', status: 'busy' };

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('worker_busy');
  });

  it('allows cleanup when the worker is merely idle', async () => {
    mergedViaPullRequest();
    liveAgent = { sessionId: 'sess-1', status: 'idle' };

    expect((await assessWorktreeCleanup(PROJECT, WORKTREE)).safe).toBe(true);
  });

  it('refuses while a merge is running for this worktree', async () => {
    mergedViaPullRequest();
    db.prepare(`
      INSERT INTO merge_locks (project_id, held_by_worktree_id, held_since, expires_at)
      VALUES (?, ?, datetime('now'), datetime('now', '+15 minutes'))
    `).run(PROJECT, WORKTREE);

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.blockers.map((b) => b.code)).toContain('merge_in_progress');
  });

  it('accepts a worktree whose directory is already gone', async () => {
    dirExists = false;

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(true);
    expect(result.mergeEvidence).toBe('worktree_missing');
    expect(result.warnings.join(' ')).toContain('no longer exists');
  });

  // Failing closed matters most here: an unreadable working tree might be
  // holding the only copy of someone's work.
  it('refuses when the working tree cannot be inspected', async () => {
    responses.push({ match: /git status --porcelain/, fail: 'not a git repository' });
    responses.push({ match: /gh pr list/, stdout: JSON.stringify([{ state: 'MERGED' }]) });

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.safe).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('uncommitted_changes');
  });

  it('accepts a worktree whose merge request already completed', async () => {
    responses.push({ match: /git status --porcelain/, stdout: '' });
    db.prepare(`
      INSERT INTO merge_requests (id, project_id, worktree_id, branch, status)
      VALUES ('m1', ?, ?, 'feature/login', 'merged')
    `).run(PROJECT, WORKTREE);

    const result = await assessWorktreeCleanup(PROJECT, WORKTREE);

    expect(result.mergeEvidence).toBe('merge_record');
    expect(calls.some((c) => c.includes('gh pr list'))).toBe(false);
  });

  it('rejects a worktree belonging to another project', async () => {
    db.prepare("INSERT INTO projects (id, name, repo_path) VALUES ('other', 'Other', 'C:/other')").run();
    await expect(assessWorktreeCleanup('other', WORKTREE)).rejects.toThrow('does not belong');
  });

  describe('closeWorktree', () => {
    it('removes the worktree and retires its sessions and delegations', async () => {
      mergedViaPullRequest();

      const result = await closeWorktree(PROJECT, WORKTREE);

      expect(result.closedSessions).toEqual(['sess-1']);
      expect(result.closedDelegations).toBe(1);
      expect(endedWorktrees).toEqual([[PROJECT, WORKTREE]]);
      expect(db.prepare('SELECT * FROM worktrees WHERE id = ?').get(WORKTREE)).toBeUndefined();
    });

    it('leaves everything untouched when the worktree is not safe', async () => {
      responses.push({ match: /git status --porcelain/, stdout: ' M src/app.ts' });
      responses.push({ match: /gh pr list/, stdout: JSON.stringify([{ state: 'MERGED' }]) });

      await expect(closeWorktree(PROJECT, WORKTREE)).rejects.toThrow('not safe to close');

      expect(endedWorktrees).toEqual([]);
      expect(db.prepare('SELECT * FROM worktrees WHERE id = ?').get(WORKTREE)).toBeTruthy();
      expect(
        (db.prepare("SELECT status FROM delegations WHERE id = 'd1'").get() as { status: string }).status,
      ).toBe('done');
    });

    // The UI dialog names what will be lost, so a user-driven delete is allowed
    // to proceed where the lead's would be refused.
    it('still closes an unsafe worktree when forced', async () => {
      responses.push({ match: /git status --porcelain/, stdout: ' M src/app.ts' });
      responses.push({ match: /gh pr list/, stdout: '[]' });
      responses.push({ match: /symbolic-ref/, stdout: 'origin/main' });
      responses.push({ match: /rev-list --count/, stdout: '4' });

      const result = await closeWorktree(PROJECT, WORKTREE, { force: true });

      expect(result.assessment.safe).toBe(false);
      expect(db.prepare('SELECT * FROM worktrees WHERE id = ?').get(WORKTREE)).toBeUndefined();
    });

    it('marks delegations closed before the worktree disappears', async () => {
      mergedViaPullRequest();
      let statusAtDeletion: string | undefined;
      const original = db.prepare.bind(db);
      vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        if (sql.startsWith('DELETE FROM worktrees')) {
          statusAtDeletion = (
            original("SELECT status FROM delegations WHERE id = 'd1'").get() as { status: string }
          ).status;
        }
        return original(sql);
      }) as typeof db.prepare);

      await closeWorktree(PROJECT, WORKTREE);

      expect(statusAtDeletion).toBe('closed');
    });
  });
});
