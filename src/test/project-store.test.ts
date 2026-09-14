import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('project store', () => {
  let db: InstanceType<typeof Database>;
  let createProject: typeof import('../shared/project-store').createProject;
  let listProjects: typeof import('../shared/project-store').listProjects;
  let getProjectById: typeof import('../shared/project-store').getProjectById;
  let updateProject: typeof import('../shared/project-store').updateProject;
  let deleteProject: typeof import('../shared/project-store').deleteProject;
  let addSkill: typeof import('../shared/project-store').addSkill;
  let listSkills: typeof import('../shared/project-store').listSkills;
  let updateSkill: typeof import('../shared/project-store').updateSkill;
  let deleteSkill: typeof import('../shared/project-store').deleteSkill;
  let getWorktreeByIssueNumber: typeof import('../shared/project-store').getWorktreeByIssueNumber;

  beforeEach(async () => {
    vi.resetModules();

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        description TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE project_skills (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE worktrees (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        name          TEXT NOT NULL,
        branch        TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        is_managed    INTEGER NOT NULL DEFAULT 1,
        type          TEXT NOT NULL DEFAULT 'worktree',
        issue_number  INTEGER,
        seed_prompt   TEXT,
        created_at    TEXT DEFAULT (datetime('now'))
      );
    `);

    let idCounter = 0;
    const existsSync = vi.fn(() => true);
    const statSync = vi.fn(() => ({ isDirectory: () => true }));

    vi.doMock('../shared/db', () => ({
      getDb: () => db,
    }));
    vi.doMock('fs', () => ({
      default: {
        existsSync,
        statSync,
        realpathSync: (value: string) => value,
      },
      existsSync,
      statSync,
      realpathSync: (value: string) => value,
    }));
    const execFileSync = vi.fn();
    vi.doMock('child_process', () => ({
      default: {
        execFileSync,
      },
      execFileSync,
    }));
    vi.stubGlobal('crypto', {
      randomUUID: () => `id-${++idCounter}`,
    } as typeof crypto);

    const mod = await import('../shared/project-store');
    createProject = mod.createProject;
    listProjects = mod.listProjects;
    getProjectById = mod.getProjectById;
    updateProject = mod.updateProject;
    deleteProject = mod.deleteProject;
    addSkill = mod.addSkill;
    listSkills = mod.listSkills;
    updateSkill = mod.updateSkill;
    deleteSkill = mod.deleteSkill;
    getWorktreeByIssueNumber = mod.getWorktreeByIssueNumber;
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates and retrieves a project', () => {
    const project = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');

    expect(project).toMatchObject({
      id: 'id-1',
      name: 'Pilot Console',
      repoPath: 'C:\\repos\\pilot-console',
      description: 'Main repo',
    });
    expect(getProjectById(project.id)).toMatchObject({ id: 'id-1', name: 'Pilot Console' });
  });

  it('lists all projects', () => {
    const first = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');
    const second = createProject('Docs', 'C:\\repos\\docs', 'Docs repo');

    const projects = listProjects();

    expect(projects).toHaveLength(2);
    expect(projects.map(project => project.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('updates a project', () => {
    const project = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');

    const updated = updateProject(project.id, {
      name: 'Pilot Console Web',
      repoPath: 'C:\\repos\\pilot-console-web',
      description: 'Updated repo',
      pinned: true,
    });

    expect(updated).toMatchObject({
      id: project.id,
      name: 'Pilot Console Web',
      repoPath: 'C:\\repos\\pilot-console-web',
      description: 'Updated repo',
    });
    expect(db.prepare('SELECT pinned FROM projects WHERE id = ?').get(project.id)).toMatchObject({ pinned: 1 });
  });

  it('deletes a project', () => {
    const project = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');

    deleteProject(project.id);

    expect(getProjectById(project.id)).toBeNull();
  });

  it('adds and lists skills for a project', () => {
    const project = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');
    const skill = addSkill(project.id, 'mcp_server', 'GitHub MCP', { url: 'http://localhost:3000' });

    expect(skill).toMatchObject({
      id: 'id-2',
      projectId: project.id,
      type: 'mcp_server',
      name: 'GitHub MCP',
      config: { url: 'http://localhost:3000' },
      enabled: true,
    });
    expect(listSkills(project.id)).toMatchObject([
      expect.objectContaining({ id: skill.id, name: 'GitHub MCP' }),
    ]);
  });

  it('updates a skill', () => {
    const project = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');
    const skill = addSkill(project.id, 'custom_instructions', 'Default Instructions', { prompt: 'Be helpful' });

    const updated = updateSkill(skill.id, {
      name: 'Updated Instructions',
      config: { prompt: 'Be very helpful' },
      enabled: false,
    });

    expect(updated).toMatchObject({
      id: skill.id,
      name: 'Updated Instructions',
      config: { prompt: 'Be very helpful' },
      enabled: false,
    });
  });

  it('deletes a skill', () => {
    const project = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');
    const skill = addSkill(project.id, 'repo_context', 'Repo Notes', { files: ['README.md'] });

    deleteSkill(skill.id);

    expect(listSkills(project.id)).toHaveLength(0);
  });

  it('finds the earliest worktree for a given issue number, scoped to the project', () => {
    const project = createProject('Pilot Console', 'C:\\repos\\pilot-console', 'Main repo');
    db.prepare(
      'INSERT INTO worktrees (id, project_id, name, branch, worktree_path, issue_number, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('wt-9a', project.id, 'issue-9', 'issue-9', 'C:\\wt\\9a', 9, '2026-01-01T00:00:00Z');
    db.prepare(
      'INSERT INTO worktrees (id, project_id, name, branch, worktree_path, issue_number, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('wt-9b', project.id, 'issue-9-again', 'issue-9-again', 'C:\\wt\\9b', 9, '2026-02-01T00:00:00Z');
    db.prepare(
      'INSERT INTO worktrees (id, project_id, name, branch, worktree_path, issue_number, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('wt-7', project.id, 'issue-7', 'issue-7', 'C:\\wt\\7', 7, '2026-01-01T00:00:00Z');

    expect(getWorktreeByIssueNumber(project.id, 9)).toMatchObject({ id: 'wt-9a', issueNumber: 9 });
    expect(getWorktreeByIssueNumber(project.id, 7)).toMatchObject({ id: 'wt-7', issueNumber: 7 });
    expect(getWorktreeByIssueNumber(project.id, 999)).toBeNull();
    expect(getWorktreeByIssueNumber('other-project', 9)).toBeNull();
  });
});
