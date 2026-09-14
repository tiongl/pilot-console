import { defineTool } from '@github/copilot-sdk';
import { createProject, createWorktree, listProjects } from './project-store';
import { listDigests } from './digest-store';
import { getDb } from './db';
import { listMergeRequests, setMergePriority } from './merge-store';
import { listCosBriefings, listCosBriefingsForProject } from './cos-briefing-store';

export function createChiefOfStaffTools() {
  return [
    defineTool('list_projects', {
      description: 'List the user portfolio without exposing project transcripts.',
      parameters: { type: 'object', properties: {} },
      handler: () => listProjects(),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_project_status', {
      description: 'Read compact worktree status rollups for one project.',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
      },
      handler: ({ projectId }: { projectId: string }) => ({
        projectId,
        digests: listDigests(projectId),
      }),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('create_project', {
      description: 'Create a project using the same validated store path as the dashboard.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          repoPath: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['name', 'repoPath'],
      },
      handler: ({ name, repoPath, description }: { name: string; repoPath: string; description?: string }) =>
        createProject(name, repoPath, description),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('create_worktree', {
      description: 'Create a project worktree using the existing validated project store.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          branch: { type: 'string' },
          createNewBranch: { type: 'boolean' },
        },
        required: ['projectId', 'name', 'branch'],
      },
      handler: ({ projectId, name, branch, createNewBranch }: { projectId: string; name: string; branch: string; createNewBranch?: boolean }) =>
        createWorktree(projectId, name, branch, createNewBranch ?? false),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('open_decision_thread', {
      description: 'Create a resumable Project Lead handoff for a project question.',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string' }, question: { type: 'string' } },
        required: ['projectId', 'question'],
      },
      handler: ({ projectId, question }: { projectId: string; question: string }) => {
        const id = crypto.randomUUID();
        getDb().prepare(`
          INSERT INTO decision_threads (id, project_id, question, title)
          VALUES (?, ?, ?, ?)
        `).run(id, projectId, question, question.slice(0, 80));
        return { id, projectId, status: 'open', question };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_decision_threads', {
      description: 'List resumable decision threads across the portfolio, optionally filtered by a search term.',
      parameters: {
        type: 'object',
        properties: { search: { type: 'string' } },
      },
      handler: ({ search }: { search?: string }) => {
        const term = search?.trim();
        if (!term) {
          return getDb().prepare(`
            SELECT dt.id, dt.project_id as projectId, p.name as projectName, dt.title, dt.question, dt.status, dt.updated_at as updatedAt
            FROM decision_threads dt JOIN projects p ON p.id = dt.project_id
            ORDER BY dt.updated_at DESC LIMIT 50
          `).all();
        }
        const pattern = `%${term}%`;
        return getDb().prepare(`
          SELECT dt.id, dt.project_id as projectId, p.name as projectName, dt.title, dt.question, dt.status, dt.updated_at as updatedAt
          FROM decision_threads dt JOIN projects p ON p.id = dt.project_id
          WHERE dt.title LIKE ? OR dt.question LIKE ? OR dt.decision LIKE ?
          ORDER BY dt.updated_at DESC LIMIT 50
        `).all(pattern, pattern, pattern);
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_project_briefings', {
      description: 'List recent Project Lead briefings summarizing project conversations and decisions. Optionally filter to one project.',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
      },
      handler: ({ projectId }: { projectId?: string }) =>
        projectId ? listCosBriefingsForProject(projectId) : listCosBriefings(),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_merge_queue', {
      description: 'List merge requests across the portfolio.',
      parameters: { type: 'object', properties: {} },
      handler: () => listMergeRequests(),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('prioritize_merge', {
      description: 'Set a normal or urgent priority for a merge request. Project Leads retain approval authority.',
      parameters: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          priority: { type: 'string', enum: ['normal', 'urgent'] },
        },
        required: ['requestId', 'priority'],
      },
      handler: ({ requestId, priority }: { requestId: string; priority: 'normal' | 'urgent' }) =>
        setMergePriority(requestId, priority),
      skipPermission: true,
      defer: 'never',
    }),
  ];
}
