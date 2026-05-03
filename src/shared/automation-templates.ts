import { getDb } from './db';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt: string;
  cronExpression: string;
  rendererType: string;
  isBuiltIn: boolean;
  createdBy: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

const builtInTemplates: Omit<AutomationTemplate, 'createdAt'>[] = [
  {
    id: 'builtin-pr-summary',
    name: 'Daily PR Summary',
    description: 'Summarize all open pull requests across the repository, including status, reviewers, and age.',
    category: 'Code Review',
    prompt: 'List all open pull requests in this repository. For each PR, include the title, author, number of approvals, any requested changes, and how many days it has been open. Group them by status: ready to merge, needs review, and has conflicts. End with a summary of the overall PR health.',
    cronExpression: '0 9 * * 1-5',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
  {
    id: 'builtin-code-review-digest',
    name: 'Code Review Digest',
    description: 'Weekly digest of code review activity — reviews given, received, and pending.',
    category: 'Code Review',
    prompt: 'Provide a weekly code review digest for this repository. Include: number of PRs merged this week, average time to merge, PRs still awaiting review (with how long they have been waiting), and any PRs with unresolved review comments. Format as a clear summary report.',
    cronExpression: '0 9 * * 1',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
  {
    id: 'builtin-open-issues',
    name: 'Open Issues Summary',
    description: 'Overview of open issues with priority labels and staleness indicators.',
    category: 'Reporting',
    prompt: 'List all open issues in this repository. Group them by label (bug, enhancement, etc.). For each issue include the title, assignee (if any), how old it is, and the last comment date. Highlight any issues that have been open for more than 30 days with no recent activity. End with a count summary.',
    cronExpression: '0 8 * * 1',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
  {
    id: 'builtin-dependency-audit',
    name: 'Dependency Audit',
    description: 'Check for outdated or vulnerable dependencies in the project.',
    category: 'Security',
    prompt: 'Audit the dependencies of this project. Check for outdated packages, known security vulnerabilities, and deprecated dependencies. List any that need updating with the current version vs latest version. Flag any with known CVEs. Provide a priority-ordered list of updates to make.',
    cronExpression: '0 7 * * 1',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
  {
    id: 'builtin-security-scan',
    name: 'Security Review',
    description: 'Scan for common security issues like hardcoded secrets, unsafe patterns, and misconfigurations.',
    category: 'Security',
    prompt: 'Perform a security review of this codebase. Look for: hardcoded secrets or API keys, SQL injection vulnerabilities, XSS risks, insecure file permissions, missing input validation, and any other common security anti-patterns. Report findings with file locations and severity levels (critical, high, medium, low).',
    cronExpression: '0 6 * * 1',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
  {
    id: 'builtin-repo-health',
    name: 'Repository Health Check',
    description: 'Overall health assessment including test coverage, documentation, and code quality indicators.',
    category: 'Maintenance',
    prompt: 'Perform a health check on this repository. Assess: README completeness, whether CI/CD is configured, test coverage (if measurable), linting configuration, branch protection status, and overall code organization. Provide a health score and actionable recommendations for improvement.',
    cronExpression: '0 9 1 * *',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
  {
    id: 'builtin-changelog',
    name: 'Weekly Changelog',
    description: 'Generate a changelog from recent commits and merged PRs.',
    category: 'Reporting',
    prompt: 'Generate a changelog for the past week. Look at all commits and merged pull requests. Group changes by category (features, bug fixes, refactoring, documentation, etc.). Include the PR number or commit hash for each entry. Format as a clean, readable changelog suitable for sharing with the team.',
    cronExpression: '0 17 * * 5',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
  {
    id: 'builtin-todo-scan',
    name: 'TODO/FIXME Scanner',
    description: 'Find and catalog all TODO, FIXME, HACK, and XXX comments in the codebase.',
    category: 'Maintenance',
    prompt: 'Search the entire codebase for TODO, FIXME, HACK, and XXX comments. For each one found, include the file path, line number, the full comment text, and the surrounding context. Group by type (TODO vs FIXME vs HACK). Provide a total count and highlight any that seem urgent or have been present for a long time.',
    cronExpression: '0 10 * * 1',
    rendererType: 'markdown',
    isBuiltIn: true,
    createdBy: null,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapTemplateRow(row: any): AutomationTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    prompt: row.prompt,
    cronExpression: row.cron_expression,
    rendererType: row.renderer_type,
    isBuiltIn: !!row.is_built_in,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns all built-in templates (no DB needed). */
export function getBuiltInTemplates(): AutomationTemplate[] {
  return builtInTemplates.map(t => ({
    ...t,
    createdAt: new Date(0).toISOString(),
  }));
}

/** Returns all user-created templates from the DB. */
export function getUserTemplates(): AutomationTemplate[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM automation_templates ORDER BY created_at DESC').all();
  return (rows as any[]).map(mapTemplateRow);
}

/** Returns all templates (built-in + user). */
export function getAllTemplates(): AutomationTemplate[] {
  return [...getBuiltInTemplates(), ...getUserTemplates()];
}

/** Creates a user template. */
export function createTemplate(data: {
  name: string;
  description: string;
  category: string;
  prompt: string;
  cronExpression: string;
  rendererType: string;
  createdBy?: string;
}): AutomationTemplate {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO automation_templates (id, name, description, category, prompt, cron_expression, renderer_type, is_built_in, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, data.name, data.description, data.category, data.prompt, data.cronExpression, data.rendererType, data.createdBy ?? null, now);

  return mapTemplateRow(
    db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(id)
  );
}

/** Deletes a user template (cannot delete built-in). */
export function deleteTemplate(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM automation_templates WHERE id = ? AND is_built_in = 0').run(id);
  return result.changes > 0;
}
