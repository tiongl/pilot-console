import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('github-store', () => {
  let db: InstanceType<typeof Database>;
  let mod: typeof import('../shared/github-store');
  let execFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT, repo_path TEXT, description TEXT,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE project_github_projects (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        gh_project_id TEXT NOT NULL,
        gh_project_number INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project_id, gh_project_id)
      );
    `);
    db.prepare('INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?)').run('p1', 'Proj', '/tmp/repo');

    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    vi.doMock('../shared/project-store', () => ({
      getProjectById: (id: string) =>
        id === 'p1' ? { id: 'p1', name: 'Proj', repoPath: '/tmp/repo' } : null,
    }));

    // Mock child_process.execFile so promisify(execFile) resolves { stdout }.
    execFile = vi.fn();
    vi.doMock('child_process', () => ({ default: { execFile }, execFile }));

    let idCounter = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `id-${++idCounter}` } as typeof crypto);

    mod = await import('../shared/github-store');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Drive the mocked execFile callback for the next N calls. */
  function whenExec(handler: (cmd: string, args: string[]) => { stdout: string } | Error) {
    execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: unknown) => {
      const callback = (typeof _opts === 'function' ? _opts : cb) as (
        e: Error | null,
        r?: { stdout: string; stderr: string },
      ) => void;
      const result = handler(cmd, args);
      if (result instanceof Error) callback(result);
      else callback(null, { stdout: result.stdout, stderr: '' });
    });
  }

  describe('parseRemoteUrl', () => {
    it('parses ssh and https remotes, stripping .git', () => {
      expect(mod.parseRemoteUrl('git@github.com:tiongl/pilot-console.git')).toEqual({
        owner: 'tiongl',
        repo: 'pilot-console',
      });
      expect(mod.parseRemoteUrl('https://github.com/tiongl/pilot-console')).toEqual({
        owner: 'tiongl',
        repo: 'pilot-console',
      });
      expect(mod.parseRemoteUrl('https://github.com/acme/my.repo.git')).toEqual({
        owner: 'acme',
        repo: 'my.repo',
      });
    });

    it('returns null for non-matching input', () => {
      expect(mod.parseRemoteUrl('not-a-url')).toBeNull();
    });
  });

  describe('cached / invalidateCache', () => {
    it('caches within the TTL and bypasses on force', async () => {
      const loader = vi.fn(async () => Math.random());
      const a = await mod.cached('k', 10_000, loader);
      const b = await mod.cached('k', 10_000, loader);
      expect(a).toBe(b);
      expect(loader).toHaveBeenCalledTimes(1);
      const c = await mod.cached('k', 10_000, loader, true);
      expect(c).not.toBe(a);
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('invalidateCache drops matching keys', async () => {
      const loader = vi.fn(async () => 'v');
      await mod.cached('repo:p1', 10_000, loader);
      mod.invalidateCache('repo:');
      await mod.cached('repo:p1', 10_000, loader);
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  describe('hasProjectScope', () => {
    it('is true when X-Oauth-Scopes contains project', async () => {
      whenExec(() => ({ stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project, workflow\n\n{}' }));
      expect(await mod.hasProjectScope(true)).toBe(true);
    });

    it('is false when the project scope is absent', async () => {
      whenExec(() => ({ stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, workflow\n\n{}' }));
      expect(await mod.hasProjectScope(true)).toBe(false);
    });
  });

  describe('resolveRepo', () => {
    it('resolves owner/repo via gh repo view and reports scope', async () => {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'tiongl' }, name: 'pilot-console' }) };
        }
        // gh api -i user (scope probe)
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project\n\n{}' };
      });
      const info = await mod.resolveRepo('p1', true);
      expect(info).toMatchObject({
        owner: 'tiongl',
        repo: 'pilot-console',
        nameWithOwner: 'tiongl/pilot-console',
        hasProjectScope: true,
      });
    });
  });

  describe('project link storage', () => {
    it('stores links, defaults the first when none flagged, and reads them back', () => {
      mod.setProjectLinks('p1', [
        { ghProjectId: 'PVT_1', ghProjectNumber: 1, title: 'Roadmap' },
        { ghProjectId: 'PVT_2', ghProjectNumber: 2, title: 'Bugs' },
      ]);
      const links = mod.listProjectLinks('p1');
      expect(links).toHaveLength(2);
      const def = mod.getDefaultProjectLink('p1');
      expect(def?.ghProjectId).toBe('PVT_1');
      expect(def?.isDefault).toBe(true);
    });

    it('replaces the set on subsequent calls and honors an explicit default', () => {
      mod.setProjectLinks('p1', [{ ghProjectId: 'PVT_1', ghProjectNumber: 1, title: 'Roadmap' }]);
      mod.setProjectLinks('p1', [
        { ghProjectId: 'PVT_2', ghProjectNumber: 2, title: 'Bugs' },
        { ghProjectId: 'PVT_3', ghProjectNumber: 3, title: 'Ops', isDefault: true },
      ]);
      const links = mod.listProjectLinks('p1');
      expect(links.map((l) => l.ghProjectId).sort()).toEqual(['PVT_2', 'PVT_3']);
      expect(mod.getDefaultProjectLink('p1')?.ghProjectId).toBe('PVT_3');
    });
  });

  describe('listIssues', () => {
    it('maps the comments array to a count', async () => {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args.includes('issue') && args.includes('list')) {
          return {
            stdout: JSON.stringify([
              { number: 1, title: 'A', state: 'OPEN', url: 'u', author: null, assignees: [], labels: [], milestone: null, comments: [{}, {}, {}], createdAt: 'c', updatedAt: 'u' },
              { number: 2, title: 'B', state: 'CLOSED', url: 'u', author: null, assignees: [], labels: [], milestone: null, comments: [], createdAt: 'c', updatedAt: 'u' },
            ]),
          };
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo\n\n{}' };
      });
      const issues = await mod.listIssues('p1', true);
      expect(issues.map((i) => i.comments)).toEqual([3, 0]);
    });
  });

  describe('moveBoardItem', () => {
    function scopedExec(onGraphql: (args: string[]) => { stdout: string } | Error) {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args.includes('graphql')) return onGraphql(args);
        // scope probe: include project so writes are permitted
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project\n\n{}' };
      });
    }

    it('sets a single-select value and invalidates the board cache', async () => {
      const seen: string[][] = [];
      scopedExec((args) => {
        seen.push(args);
        return { stdout: JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'i1' } } } }) };
      });
      await mod.moveBoardItem('p1', 'PVT_1', 'ITEM_1', 'FIELD_1', 'OPT_1');
      const flat = seen[0].join(' ');
      expect(flat).toContain('updateProjectV2ItemFieldValue');
      expect(flat).toContain('value=OPT_1');
      expect(flat).toContain('item=ITEM_1');
      expect(flat).toContain('field=FIELD_1');
    });

    it('clears the value when optionId is null', async () => {
      const seen: string[][] = [];
      scopedExec((args) => {
        seen.push(args);
        return { stdout: JSON.stringify({ data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'i1' } } } }) };
      });
      await mod.moveBoardItem('p1', 'PVT_1', 'ITEM_1', 'FIELD_1', null);
      expect(seen[0].join(' ')).toContain('clearProjectV2ItemFieldValue');
    });

    it('throws missing-scope when the token lacks the project scope', async () => {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, workflow\n\n{}' };
      });
      await expect(mod.moveBoardItem('p1', 'PVT_1', 'ITEM_1', 'FIELD_1', 'OPT_1')).rejects.toMatchObject({
        code: 'missing-scope',
      });
    });
  });

  describe('createBoardIssue / updateIssueTitle / removeBoardItem', () => {
    function scopedExec(dispatch: (args: string[]) => { stdout: string } | Error) {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        // scope probe: gh api -i user
        if (args.includes('-i') && args.includes('user')) {
          return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project\n\n{}' };
        }
        return dispatch(args);
      });
    }

    it('creates an issue, adds it to the board, and sets its status', async () => {
      const calls: string[][] = [];
      scopedExec((args) => {
        calls.push(args);
        if (args[0] === 'api' && !args.includes('graphql')) {
          return { stdout: JSON.stringify({ number: 7, node_id: 'NODE_7', html_url: 'https://x/7' }) };
        }
        // graphql: add item, then move
        const q = args.find((a) => a.startsWith('query=')) ?? '';
        if (q.includes('addProjectV2ItemById')) {
          return { stdout: JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'ITEM_7' } } } }) };
        }
        return { stdout: JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_7' } } } }) };
      });

      const out = await mod.createBoardIssue('p1', 'PVT_1', 'FIELD_1', 'OPT_1', 'New bug', 'details');
      expect(out).toEqual({ itemId: 'ITEM_7', number: 7, url: 'https://x/7' });
      const createCall = calls.find((a) => a[0] === 'api' && !a.includes('graphql'))!;
      expect(createCall.join(' ')).toContain('repos/o/r/issues');
      expect(createCall.join(' ')).toContain('title=New bug');
      // The add-to-board mutation must reference the created node id.
      const addCall = calls.find((a) => (a.find((x) => x.startsWith('query=')) ?? '').includes('addProjectV2ItemById'))!;
      expect(addCall.join(' ')).toContain('content=NODE_7');
    });

    it('patches the issue title via REST', async () => {
      const calls: string[][] = [];
      scopedExec((args) => {
        calls.push(args);
        return { stdout: '{}' };
      });
      await mod.updateIssueTitle('p1', 7, 'Renamed');
      const patch = calls.find((a) => a.includes('PATCH'))!;
      expect(patch.join(' ')).toContain('repos/o/r/issues/7');
      expect(patch.join(' ')).toContain('title=Renamed');
    });

    it('removes a card via deleteProjectV2Item', async () => {
      const calls: string[][] = [];
      scopedExec((args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ data: { deleteProjectV2Item: { deletedItemId: 'ITEM_7' } } }) };
      });
      await mod.removeBoardItem('p1', 'PVT_1', 'ITEM_7');
      const del = calls.find((a) => (a.find((x) => x.startsWith('query=')) ?? '').includes('deleteProjectV2Item'))!;
      expect(del.join(' ')).toContain('item=ITEM_7');
    });
  });
});
