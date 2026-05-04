import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getDb } from './db';
import type { Project, ProjectSkill, SkillType, Worktree } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    repoPath: row.repo_path as string,
    description: (row.description as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToSkill(row: Record<string, unknown>): ProjectSkill {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as SkillType,
    name: row.name as string,
    config: JSON.parse(row.config as string),
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as string,
  };
}

/** Ensure the path exists and looks like a directory (optionally a git repo). */
function validateRepoPath(repoPath: string): string | null {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) return 'Path does not exist';
  if (!fs.statSync(resolved).isDirectory()) return 'Path is not a directory';
  return null;
}

// ---------------------------------------------------------------------------
// Projects CRUD
// ---------------------------------------------------------------------------

export function createProject(
  name: string,
  repoPath: string,
  description?: string | null,
): Project {
  const err = validateRepoPath(repoPath);
  if (err) throw new Error(err);

  const id = crypto.randomUUID();
  const resolved = path.resolve(repoPath);
  getDb()
    .prepare('INSERT INTO projects (id, name, repo_path, description) VALUES (?, ?, ?, ?)')
    .run(id, name, resolved, description ?? null);

  return getProjectById(id)!;
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToProject);
}

export function getProjectById(id: string): Project | null {
  const row = getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

export function updateProject(
  id: string,
  fields: { name?: string; repoPath?: string; description?: string | null; pinned?: boolean },
): Project {
  const existing = getProjectById(id);
  if (!existing) throw new Error('Project not found');

  if (fields.repoPath) {
    const err = validateRepoPath(fields.repoPath);
    if (err) throw new Error(err);
    fields.repoPath = path.resolve(fields.repoPath);
  }

  const name = fields.name ?? existing.name;
  const repoPath = fields.repoPath ?? existing.repoPath;
  const description = fields.description !== undefined ? fields.description : existing.description;

  getDb()
    .prepare("UPDATE projects SET name = ?, repo_path = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, repoPath, description, id);

  // Update pinned status if provided (column added by schema migration)
  if (fields.pinned !== undefined) {
    try {
      getDb()
        .prepare('UPDATE projects SET pinned = ? WHERE id = ?')
        .run(fields.pinned ? 1 : 0, id);
    } catch {
      // pinned column may not exist yet
    }
  }

  return getProjectById(id)!;
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Project Skills CRUD
// ---------------------------------------------------------------------------

export function addSkill(
  projectId: string,
  type: SkillType,
  name: string,
  config: Record<string, unknown>,
): ProjectSkill {
  const id = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO project_skills (id, project_id, type, name, config) VALUES (?, ?, ?, ?, ?)')
    .run(id, projectId, type, name, JSON.stringify(config));
  return getSkillById(id)!;
}

export function listSkills(projectId: string): ProjectSkill[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_skills WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

export function getSkillById(id: string): ProjectSkill | null {
  const row = getDb()
    .prepare('SELECT * FROM project_skills WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : null;
}

export function updateSkill(
  id: string,
  fields: { name?: string; config?: Record<string, unknown>; enabled?: boolean },
): ProjectSkill {
  const existing = getSkillById(id);
  if (!existing) throw new Error('Skill not found');

  const name = fields.name ?? existing.name;
  const config = fields.config ? JSON.stringify(fields.config) : JSON.stringify(existing.config);
  const enabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);

  getDb()
    .prepare('UPDATE project_skills SET name = ?, config = ?, enabled = ? WHERE id = ?')
    .run(name, config, enabled, id);
  return getSkillById(id)!;
}

export function deleteSkill(id: string): void {
  getDb().prepare('DELETE FROM project_skills WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Worktrees CRUD
// ---------------------------------------------------------------------------

function rowToWorktree(row: Record<string, unknown>): Worktree {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    branch: row.branch as string,
    worktreePath: row.worktree_path as string,
    isManaged: (row.is_managed as number | undefined) !== 0,
    createdAt: row.created_at as string,
  };
}

/** Sanitize a worktree name into a filesystem-safe slug */
function sanitizeWorktreeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    timeout: 30_000,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function resolveGitPath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

function getGitCommonDir(repoPath: string): string {
  return normalizePathForComparison(resolveGitPath(repoPath, gitOutput(repoPath, ['rev-parse', '--git-common-dir'])));
}

function getWorktreeBranch(worktreePath: string): string {
  const branch = gitOutput(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'HEAD') return branch;
  return gitOutput(worktreePath, ['rev-parse', '--short', 'HEAD']);
}

export function createWorktree(
  projectId: string,
  name: string,
  branch: string,
  createNewBranch: boolean = false,
): Worktree {
  const project = getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const slug = sanitizeWorktreeName(name);
  if (!slug) throw new Error('Invalid worktree name');
  if (!branch.trim()) throw new Error('Branch is required');

  // Derive worktree path as sibling to main repo
  const repoDir = path.basename(project.repoPath);
  const wtPath = path.resolve(project.repoPath, '..', `${repoDir}-wt-${slug}`);

  if (fs.existsSync(wtPath)) {
    throw new Error(`Path already exists: ${wtPath}`);
  }

  // Run git worktree add
  const args = ['worktree', 'add'];
  if (createNewBranch) {
    args.push('-b', branch.trim());
  }
  args.push(wtPath);
  if (!createNewBranch) {
    args.push(branch.trim());
  }

  try {
    execFileSync('git', args, {
      cwd: project.repoPath,
      timeout: 30_000,
      stdio: 'pipe',
    });
  } catch (err) {
    const msg = (err as { stderr?: Buffer }).stderr?.toString() || (err as Error).message;
    throw new Error(`git worktree add failed: ${msg}`);
  }

  const id = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO worktrees (id, project_id, name, branch, worktree_path, is_managed) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, slug, branch.trim(), wtPath, 1);

  return getWorktreeById(id)!;
}

export function attachExistingWorktree(
  projectId: string,
  name: string | undefined,
  worktreePath: string,
  branch?: string,
): Worktree {
  const project = getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const resolvedPath = path.resolve(worktreePath.trim());
  if (!fs.existsSync(resolvedPath)) throw new Error('Worktree path does not exist');
  if (!fs.statSync(resolvedPath).isDirectory()) throw new Error('Worktree path is not a directory');
  if (normalizePathForComparison(resolvedPath) === normalizePathForComparison(project.repoPath)) {
    throw new Error('Project root is already registered');
  }

  let topLevel: string;
  let detectedBranch: string;
  try {
    topLevel = gitOutput(resolvedPath, ['rev-parse', '--show-toplevel']);
    detectedBranch = branch?.trim() || getWorktreeBranch(resolvedPath);
  } catch (err) {
    const msg = (err as { stderr?: Buffer | string }).stderr?.toString() || (err as Error).message;
    throw new Error(`Invalid git worktree: ${msg}`);
  }

  if (normalizePathForComparison(topLevel) !== normalizePathForComparison(resolvedPath)) {
    throw new Error('Worktree path must point to the worktree root');
  }
  if (getGitCommonDir(project.repoPath) !== getGitCommonDir(resolvedPath)) {
    throw new Error('Worktree does not belong to this project repository');
  }

  const displayName = name?.trim() || path.basename(resolvedPath);
  if (!displayName) throw new Error('Worktree name is required');

  const id = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO worktrees (id, project_id, name, branch, worktree_path, is_managed) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, displayName, detectedBranch, resolvedPath, 0);

  return getWorktreeById(id)!;
}

export function listWorktrees(projectId: string): Worktree[] {
  const rows = getDb()
    .prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToWorktree);
}

export function getWorktreeById(id: string): Worktree | null {
  const row = getDb()
    .prepare('SELECT * FROM worktrees WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToWorktree(row) : null;
}

export function deleteWorktree(id: string, projectId: string): void {
  const wt = getWorktreeById(id);
  if (!wt) throw new Error('Worktree not found');
  if (wt.projectId !== projectId) throw new Error('Worktree does not belong to this project');

  // Only app-created worktrees are removed from disk. Attached existing worktrees are only unregistered.
  const project = getProjectById(wt.projectId);
  if (project && wt.isManaged) {
    try {
      execFileSync('git', ['worktree', 'remove', wt.worktreePath, '--force'], {
        cwd: project.repoPath,
        timeout: 30_000,
        stdio: 'pipe',
      });
    } catch {
      // If git remove fails (e.g., already gone), still clean up DB
    }
  }

  getDb().prepare('DELETE FROM worktrees WHERE id = ?').run(id);
}
