import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('github-store', () => {
  let db: InstanceType<typeof Database>;
  let mod: typeof import('../shared/github-store');
  let execFile: ReturnType<typeof vi.fn>;
  let worktreeRow: { id: string; projectId: string; branch: string; worktreePath: string; issueNumber: number | null } | null;

  beforeEach(async () => {
    vi.resetModules();
    worktreeRow = null;

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
      CREATE TABLE project_view_names (
        project_id TEXT NOT NULL,
        gh_project_id TEXT NOT NULL,
        view_number INTEGER NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, gh_project_id, view_number)
      );
    `);
    db.prepare('INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?)').run('p1', 'Proj', '/tmp/repo');

    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    vi.doMock('../shared/project-store', () => ({
      getProjectById: (id: string) =>
        id === 'p1' ? { id: 'p1', name: 'Proj', repoPath: '/tmp/repo' } : null,
      getWorktreeById: () => worktreeRow,
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

  describe('view name overrides', () => {
    it('sets, reads, updates and scopes overrides by project + gh project', () => {
      mod.setViewNameOverride('p1', 'PVT_1', 1, 'My Board');
      mod.setViewNameOverride('p1', 'PVT_1', 2, 'My Table');
      mod.setViewNameOverride('p1', 'PVT_2', 1, 'Other');
      expect(mod.getViewNameOverrides('p1', 'PVT_1')).toEqual({ 1: 'My Board', 2: 'My Table' });
      expect(mod.getViewNameOverrides('p1', 'PVT_2')).toEqual({ 1: 'Other' });

      mod.setViewNameOverride('p1', 'PVT_1', 1, 'Renamed');
      expect(mod.getViewNameOverrides('p1', 'PVT_1')[1]).toBe('Renamed');
    });

    it('trims names and clears the override when blank/null', () => {
      mod.setViewNameOverride('p1', 'PVT_1', 1, '  Padded  ');
      expect(mod.getViewNameOverrides('p1', 'PVT_1')[1]).toBe('Padded');

      mod.setViewNameOverride('p1', 'PVT_1', 1, '   ');
      expect(mod.getViewNameOverrides('p1', 'PVT_1')[1]).toBeUndefined();

      mod.setViewNameOverride('p1', 'PVT_1', 2, 'Keep');
      mod.setViewNameOverride('p1', 'PVT_1', 2, null);
      expect(mod.getViewNameOverrides('p1', 'PVT_1')[2]).toBeUndefined();
    });
  });

  describe('createLinkedProjectV2', () => {
    function scopedExec(onGraphql: (args: string[], query: string) => { stdout: string } | Error) {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args.includes('graphql')) {
          const q = args.find((a) => a.startsWith('query=')) ?? '';
          return onGraphql(args, q);
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project\n\n{}' };
      });
    }

    it('creates a board, links it to the repo, and persists it as the default', async () => {
      const seen: string[] = [];
      scopedExec((_args, query) => {
        seen.push(query);
        if (query.includes('repository(owner:$owner,name:$repo){ id owner')) {
          return { stdout: JSON.stringify({ data: { repository: { id: 'REPO_1', owner: { id: 'OWNER_1' } } } }) };
        }
        if (query.includes('createProjectV2')) {
          return {
            stdout: JSON.stringify({
              data: { createProjectV2: { projectV2: { id: 'PVT_NEW', number: 7, title: 'My Board', url: 'u' } } },
            }),
          };
        }
        if (query.includes('linkProjectV2ToRepository')) {
          return { stdout: JSON.stringify({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_1' } } } }) };
        }
        return new Error(`unexpected graphql: ${query}`);
      });

      const link = await mod.createLinkedProjectV2('p1', 'My Board');
      expect(link).toMatchObject({ ghProjectId: 'PVT_NEW', ghProjectNumber: 7, title: 'My Board', isDefault: true });
      expect(mod.getDefaultProjectLink('p1')?.ghProjectId).toBe('PVT_NEW');
      expect(seen.some((q) => q.includes('createProjectV2'))).toBe(true);
      expect(seen.some((q) => q.includes('linkProjectV2ToRepository'))).toBe(true);
    });

    it('keeps existing links and makes the new board the default', async () => {
      mod.setProjectLinks('p1', [{ ghProjectId: 'PVT_OLD', ghProjectNumber: 1, title: 'Old', isDefault: true }]);
      scopedExec((_args, query) => {
        if (query.includes('repository(owner:$owner,name:$repo){ id owner')) {
          return { stdout: JSON.stringify({ data: { repository: { id: 'REPO_1', owner: { id: 'OWNER_1' } } } }) };
        }
        if (query.includes('createProjectV2')) {
          return {
            stdout: JSON.stringify({
              data: { createProjectV2: { projectV2: { id: 'PVT_NEW', number: 7, title: 'New', url: 'u' } } },
            }),
          };
        }
        return { stdout: JSON.stringify({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_1' } } } }) };
      });

      await mod.createLinkedProjectV2('p1', 'New');
      const links = mod.listProjectLinks('p1');
      expect(links.map((l) => l.ghProjectId).sort()).toEqual(['PVT_NEW', 'PVT_OLD']);
      expect(mod.getDefaultProjectLink('p1')?.ghProjectId).toBe('PVT_NEW');
    });

    it('rejects an empty title', async () => {
      scopedExec(() => ({ stdout: '{}' }));
      await expect(mod.createLinkedProjectV2('p1', '   ')).rejects.toMatchObject({ code: 'failed' });
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

  describe('getIssueDetail', () => {
    it('maps issue view JSON including the body', async () => {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args.includes('issue') && args.includes('view')) {
          return {
            stdout: JSON.stringify({
              number: 5, title: 'Fix thing', state: 'OPEN', url: 'https://x/5', body: '## Details\nDo it',
              author: { login: 'me' }, assignees: [], labels: [{ name: 'bug', color: 'f00' }],
              milestone: { title: 'v1' }, comments: [{}, {}], createdAt: 'c', updatedAt: 'u',
            }),
          };
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo\n\n{}' };
      });
      const issue = await mod.getIssueDetail('p1', 5, true);
      expect(issue).toMatchObject({ number: 5, title: 'Fix thing', body: '## Details\nDo it', comments: 2, milestone: 'v1' });
      expect(issue.labels).toEqual([{ name: 'bug', color: 'f00' }]);
    });
  });

  describe('updateIssue', () => {
    it('PATCHes title and body and rejects an empty update', async () => {
      const calls: string[][] = [];
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args[0] === 'api') { calls.push(args); return { stdout: '{}' }; }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo\n\n{}' };
      });
      await mod.updateIssue('p1', 5, { title: 'New title', body: 'New body' });
      const patch = calls.find((a) => a.includes('PATCH'))!;
      expect(patch.join(' ')).toContain('repos/o/r/issues/5');
      expect(patch.join(' ')).toContain('title=New title');
      expect(patch.join(' ')).toContain('body=New body');
      await expect(mod.updateIssue('p1', 5, {})).rejects.toBeInstanceOf(Error);
    });
  });

  describe('createPullRequest', () => {
    it('pushes the branch and opens a PR appending Closes #N for issue worktrees', async () => {
      worktreeRow = { id: 'wt1', projectId: 'p1', branch: 'issue-9-fix', worktreePath: '/tmp/repo-wt', issueNumber: 9 };
      const calls: string[][] = [];
      whenExec((cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'git') return { stdout: '' };
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          return { stdout: 'https://github.com/o/r/pull/42\n' };
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo\n\n{}' };
      });

      const out = await mod.createPullRequest('p1', 'wt1', { title: 'My PR', body: 'Work done' });
      expect(out).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42' });

      const push = calls.find((a) => a[0] === 'git' && a.includes('push'))!;
      expect(push.join(' ')).toContain('HEAD:issue-9-fix');

      const create = calls.find((a) => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'create')!;
      const flat = create.join(' ');
      expect(flat).toContain('--head issue-9-fix');
      expect(flat).toContain('--title My PR');
      expect(flat).toContain('Closes #9');
    });

    it('does not duplicate a closing keyword already present in the body', async () => {
      worktreeRow = { id: 'wt1', projectId: 'p1', branch: 'issue-3', worktreePath: '/tmp/repo-wt', issueNumber: 3 };
      const calls: string[][] = [];
      whenExec((cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'git') return { stdout: '' };
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args[0] === 'pr' && args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/8\n' };
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo\n\n{}' };
      });
      await mod.createPullRequest('p1', 'wt1', { title: 'T', body: 'Fixes #3 already' });
      const create = calls.find((a) => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'create')!;
      const bodyIdx = create.indexOf('--body');
      expect(create[bodyIdx + 1]).toBe('Fixes #3 already');
    });
  });

  describe('getProjectOverview', () => {
    function scopedExec(onGraphql: (query: string) => { stdout: string } | Error) {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args.includes('graphql')) {
          const q = args.find((a) => a.startsWith('query=')) ?? '';
          return onGraphql(q);
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project\n\n{}' };
      });
    }

    it('maps metadata, visibility and views with normalized layouts + group fields', async () => {
      scopedExec(() => ({
        stdout: JSON.stringify({
          data: {
            node: {
              id: 'PVT_1', number: 4, title: 'Roadmap', shortDescription: 'desc',
              public: true, url: 'https://x/4', viewerCanUpdate: true,
              views: {
                nodes: [
                  { id: 'V1', number: 1, name: 'Board', layout: 'BOARD_LAYOUT', verticalGroupByFields: { nodes: [{ name: 'Status' }] }, groupByFields: { nodes: [] } },
                  { id: 'V2', number: 2, name: 'Table', layout: 'TABLE_LAYOUT', verticalGroupByFields: { nodes: [] }, groupByFields: { nodes: [{ name: 'Priority' }] } },
                  { id: 'V3', number: 3, name: 'Plan', layout: 'ROADMAP_LAYOUT', verticalGroupByFields: { nodes: [] }, groupByFields: { nodes: [] } },
                ],
              },
            },
          },
        }),
      }));
      const ov = await mod.getProjectOverview('p1', 'PVT_1', true);
      expect(ov).toMatchObject({ id: 'PVT_1', number: 4, title: 'Roadmap', public: true, viewerCanUpdate: true });
      expect(ov.views).toEqual([
        { id: 'V1', number: 1, name: 'Board', layout: 'board', groupByField: 'Status' },
        { id: 'V2', number: 2, name: 'Table', layout: 'table', groupByField: 'Priority' },
        { id: 'V3', number: 3, name: 'Plan', layout: 'roadmap', groupByField: null },
      ]);
    });

    it('throws not-found when the node is null', async () => {
      scopedExec(() => ({ stdout: JSON.stringify({ data: { node: null } }) }));
      await expect(mod.getProjectOverview('p1', 'MISSING', true)).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('getProjectView', () => {
    function scopedExec(dispatch: (query: string) => { stdout: string } | Error) {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args.includes('graphql')) {
          const q = args.find((a) => a.startsWith('query=')) ?? '';
          return dispatch(q);
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project\n\n{}' };
      });
    }

    it('resolves a board view: columns from the group field, items with status', async () => {
      scopedExec((q) => {
        if (q.includes('ProjectV2SingleSelectField')) {
          return {
            stdout: JSON.stringify({
              data: {
                node: {
                  number: 4, title: 'Proj',
                  fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'F_STATUS', name: 'Status', options: [{ id: 'OPT_TODO', name: 'Todo' }, { id: 'OPT_DONE', name: 'Done' }] }] },
                  views: { nodes: [{ number: 1, name: 'Board', layout: 'BOARD_LAYOUT', verticalGroupByFields: { nodes: [{ name: 'Status' }] }, groupByFields: { nodes: [] } }] },
                },
              },
            }),
          };
        }
        // items page
        return {
          stdout: JSON.stringify({
            data: {
              node: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'ITEM_1',
                      fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', field: { name: 'Status' } }] },
                      content: { __typename: 'Issue', number: 11, title: 'Bug', url: 'https://x/11', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] } },
                    },
                  ],
                },
              },
            },
          }),
        };
      });

      const view = await mod.getProjectView('p1', 'PVT_1', 1, true);
      expect(view).toMatchObject({ layout: 'board', groupFieldId: 'F_STATUS', groupFieldName: 'Status', viewNumber: 1, name: 'Board' });
      expect(view.columns).toEqual([{ id: 'OPT_TODO', name: 'Todo' }, { id: 'OPT_DONE', name: 'Done' }]);
      expect(view.items).toHaveLength(1);
      expect(view.items[0]).toMatchObject({ itemId: 'ITEM_1', number: 11, status: 'Todo', state: 'open' });
    });

    it('derives roadmap start/target dates from date fields', async () => {
      scopedExec((q) => {
        if (q.includes('ProjectV2SingleSelectField')) {
          return {
            stdout: JSON.stringify({
              data: {
                node: {
                  number: 4, title: 'Proj',
                  fields: { nodes: [] },
                  views: { nodes: [{ number: 2, name: 'Plan', layout: 'ROADMAP_LAYOUT', verticalGroupByFields: { nodes: [] }, groupByFields: { nodes: [] } }] },
                },
              },
            }),
          };
        }
        return {
          stdout: JSON.stringify({
            data: {
              node: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'ITEM_1',
                      fieldValues: { nodes: [
                        { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-01-05', field: { name: 'Start Date' } },
                        { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-02-01', field: { name: 'Target Date' } },
                      ] },
                      content: { __typename: 'Issue', number: 3, title: 'Epic', url: 'https://x/3', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] } },
                    },
                  ],
                },
              },
            },
          }),
        };
      });
      const view = await mod.getProjectView('p1', 'PVT_1', 2, true);
      expect(view.layout).toBe('roadmap');
      expect(view.items[0]).toMatchObject({ startDate: '2026-01-05', targetDate: '2026-02-01' });
      expect(view.items[0].fields).toMatchObject({ 'Start Date': '2026-01-05', 'Target Date': '2026-02-01' });
    });

    it('throws not-found when the view number is unknown', async () => {
      scopedExec(() => ({
        stdout: JSON.stringify({ data: { node: { number: 4, title: 'Proj', fields: { nodes: [] }, views: { nodes: [] } } } }),
      }));
      await expect(mod.getProjectView('p1', 'PVT_1', 99, true)).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('updateProjectMeta', () => {
    function scopedExec(capture: (args: string[], query: string) => void) {
      whenExec((_cmd, args) => {
        if (args.includes('repo') && args.includes('view')) {
          return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
        }
        if (args.includes('graphql')) {
          const q = args.find((a) => a.startsWith('query=')) ?? '';
          capture(args, q);
          return { stdout: JSON.stringify({ data: { updateProjectV2: { projectV2: { id: 'PVT_1' } } } }) };
        }
        return { stdout: 'HTTP/2 200\nX-Oauth-Scopes: repo, project\n\n{}' };
      });
    }

    it('builds a mutation only for provided fields and types the boolean', async () => {
      let seenArgs: string[] = [];
      let seenQuery = '';
      scopedExec((args, q) => { seenArgs = args; seenQuery = q; });
      await mod.updateProjectMeta('p1', 'PVT_1', { title: 'New', public: true });
      expect(seenQuery).toContain('updateProjectV2');
      expect(seenQuery).toContain('title:$title');
      expect(seenQuery).toContain('public:$public');
      expect(seenQuery).not.toContain('shortDescription');
      const flat = seenArgs.join(' ');
      expect(flat).toContain('title=New');
      // boolean must be passed as a typed field (-F)
      const fIdx = seenArgs.indexOf('public=true');
      expect(seenArgs[fIdx - 1]).toBe('-F');
    });

    it('rejects when there is nothing to update', async () => {
      scopedExec(() => {});
      await expect(mod.updateProjectMeta('p1', 'PVT_1', {})).rejects.toMatchObject({ code: 'failed' });
    });
  });
});
