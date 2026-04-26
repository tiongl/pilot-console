import fs from 'fs';
import path from 'path';
import { getDb } from './db';
import type { Project, ProjectSkill, SkillType } from './types';

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
