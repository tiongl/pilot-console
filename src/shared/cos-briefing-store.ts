import { randomUUID } from 'crypto';
import { getDb } from './db';

export interface CosBriefing {
  id: string;
  projectId: string;
  projectName: string;
  summary: string;
  createdAt: string;
}

/** Records a Project Lead → Chief of Staff briefing so CoS stays aware of project conversations. */
export function recordCosBriefing(projectId: string, summary: string): CosBriefing {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO cos_briefings (id, project_id, summary)
    VALUES (?, ?, ?)
  `).run(id, projectId, summary);
  const row = getDb().prepare(`
    SELECT b.id, b.project_id as projectId, p.name as projectName, b.summary, b.created_at as createdAt
    FROM cos_briefings b JOIN projects p ON p.id = b.project_id
    WHERE b.id = ?
  `).get(id) as CosBriefing;
  return row;
}

export function listCosBriefings(limit = 25): CosBriefing[] {
  return getDb().prepare(`
    SELECT b.id, b.project_id as projectId, p.name as projectName, b.summary, b.created_at as createdAt
    FROM cos_briefings b JOIN projects p ON p.id = b.project_id
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(limit) as CosBriefing[];
}

export function listCosBriefingsForProject(projectId: string, limit = 10): CosBriefing[] {
  return getDb().prepare(`
    SELECT b.id, b.project_id as projectId, p.name as projectName, b.summary, b.created_at as createdAt
    FROM cos_briefings b JOIN projects p ON p.id = b.project_id
    WHERE b.project_id = ?
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(projectId, limit) as CosBriefing[];
}
