import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDb } from './db';
import { getProjectById, listWorktrees } from './project-store';
import { listDigests } from './digest-store';

export interface ProjectMemory {
  projectId: string;
  summary: string;
  source: string | null;
  updatedAt: string | null;
}

function rowToMemory(row: Record<string, unknown>): ProjectMemory {
  return {
    projectId: row.project_id as string,
    summary: row.summary as string,
    source: (row.source as string) ?? null,
    updatedAt: (row.updated_at as string) ?? null,
  };
}

function gitLogLines(repoPath: string, count = 15): string {
  try {
    return execFileSync('git', ['log', `-${count}`, '--pretty=format:%h %s'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function readReadmeHead(repoPath: string, maxChars = 1500): string {
  const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.txt'];
  for (const name of candidates) {
    const filePath = path.join(repoPath, name);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        return content.slice(0, maxChars);
      }
    } catch {
      // ignore unreadable readme
    }
  }
  return '';
}

/**
 * Assembles a fresh project-understanding summary from the repository README,
 * recent commit history, worktree/digest state, and any open decision threads.
 * This is what the Project Lead uses to "bootstrap its memory" of a project
 * it has not (or has not recently) worked in.
 */
export function synthesizeProjectMemory(projectId: string): string {
  const project = getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const readme = readReadmeHead(project.repoPath);
  const commits = gitLogLines(project.repoPath);
  const worktrees = listWorktrees(projectId);
  const digests = listDigests(projectId);
  const openThreads = getDb().prepare(
    `SELECT id, title, question FROM decision_threads WHERE project_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 10`,
  ).all(projectId) as Array<{ id: string; title: string | null; question: string }>;

  const sections: string[] = [];
  sections.push(`# Project: ${project.name}\nRepo: ${project.repoPath}${project.description ? `\n${project.description}` : ''}`);
  if (readme) sections.push(`## README (excerpt)\n${readme}`);
  if (commits) sections.push(`## Recent commits\n${commits}`);
  sections.push(`## Worktrees (${worktrees.length})\n${worktrees.map((w) => `- ${w.name} (${w.branch})`).join('\n') || 'None yet.'}`);
  if (digests.length) {
    sections.push(`## Worktree status\n${digests.map((d) => `- ${d.worktreeId}: ${d.status ?? 'unknown'} — ${d.headline ?? 'no headline'}`).join('\n')}`);
  }
  if (openThreads.length) {
    // Ids are included so the lead can close a specific thread with
    // resolve_decision_thread instead of only knowing one exists.
    sections.push(
      `## Open decision threads\n${openThreads
        .map((t) => `- [${t.id}] ${t.title || t.question}`)
        .join('\n')}`,
    );
  }
  return sections.join('\n\n');
}

export function getProjectMemory(projectId: string): ProjectMemory | null {
  const row = getDb().prepare('SELECT * FROM project_memory WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined;
  return row ? rowToMemory(row) : null;
}

function saveProjectMemory(projectId: string, summary: string, source: string): ProjectMemory {
  getDb().prepare(`
    INSERT INTO project_memory (project_id, summary, source, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET
      summary = excluded.summary,
      source = excluded.source,
      updated_at = datetime('now')
  `).run(projectId, summary, source);
  return getProjectMemory(projectId)!;
}

/** Bootstraps memory for a project that has none yet, without disturbing an existing bootstrap. */
export function getOrBootstrapProjectMemory(projectId: string): ProjectMemory {
  const existing = getProjectMemory(projectId);
  if (existing) return existing;
  return saveProjectMemory(projectId, synthesizeProjectMemory(projectId), 'auto-bootstrap');
}

/** Explicitly re-synthesizes memory, overwriting any prior bootstrap. */
export function refreshProjectMemory(projectId: string): ProjectMemory {
  return saveProjectMemory(projectId, synthesizeProjectMemory(projectId), 'manual-refresh');
}
