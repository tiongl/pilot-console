import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('automation templates', () => {
  let db: InstanceType<typeof Database>;
  let getBuiltInTemplates: typeof import('../shared/automation-templates').getBuiltInTemplates;
  let getUserTemplates: typeof import('../shared/automation-templates').getUserTemplates;
  let getAllTemplates: typeof import('../shared/automation-templates').getAllTemplates;
  let createTemplate: typeof import('../shared/automation-templates').createTemplate;
  let deleteTemplate: typeof import('../shared/automation-templates').deleteTemplate;

  beforeEach(async () => {
    vi.resetModules();

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE automation_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'General',
        prompt TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        renderer_type TEXT NOT NULL DEFAULT 'plaintext',
        is_built_in INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    let idCounter = 0;
    vi.doMock('../shared/db', () => ({
      getDb: () => db,
    }));
    vi.doMock('uuid', () => ({
      v4: () => `template-${++idCounter}`,
    }));

    const mod = await import('../shared/automation-templates');
    getBuiltInTemplates = mod.getBuiltInTemplates;
    getUserTemplates = mod.getUserTemplates;
    getAllTemplates = mod.getAllTemplates;
    createTemplate = mod.createTemplate;
    deleteTemplate = mod.deleteTemplate;
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  it('returns all built-in templates marked as built-in', () => {
    const templates = getBuiltInTemplates();

    expect(templates).toHaveLength(8);
    expect(templates.every(template => template.isBuiltIn)).toBe(true);
  });

  it('creates a user template with the expected fields', () => {
    const template = createTemplate({
      name: 'Nightly Summary',
      description: 'Summarize work every night',
      category: 'Reporting',
      prompt: 'Summarize recent activity',
      cronExpression: '0 22 * * *',
      rendererType: 'markdown',
      createdBy: 'alice',
    });

    expect(template).toMatchObject({
      id: 'template-1',
      name: 'Nightly Summary',
      description: 'Summarize work every night',
      category: 'Reporting',
      prompt: 'Summarize recent activity',
      cronExpression: '0 22 * * *',
      rendererType: 'markdown',
      isBuiltIn: false,
      createdBy: 'alice',
    });
    expect(template.createdAt).toEqual(expect.any(String));
  });

  it('returns all templates from the database (including built-in rows)', () => {
    db.prepare(`
      INSERT INTO automation_templates (id, name, description, category, prompt, cron_expression, renderer_type, is_built_in, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'builtin-db',
      'Built-in From DB',
      'Also returned',
      'General',
      'ignore me',
      '* * * * *',
      'plaintext',
      1,
      null,
    );

    const created = createTemplate({
      name: 'User Template',
      description: 'User-owned template',
      category: 'General',
      prompt: 'Run report',
      cronExpression: '*/15 * * * *',
      rendererType: 'plaintext',
    });

    const userTemplates = getUserTemplates();

    // getUserTemplates returns ALL rows from the DB (no built-in filter)
    expect(userTemplates).toHaveLength(2);
    expect(userTemplates.some(t => t.id === created.id)).toBe(true);
  });

  it('returns both built-in and user templates together', () => {
    createTemplate({
      name: 'User Template',
      description: 'User-owned template',
      category: 'General',
      prompt: 'Run report',
      cronExpression: '*/15 * * * *',
      rendererType: 'plaintext',
    });

    const templates = getAllTemplates();

    expect(templates).toHaveLength(9);
    expect(templates.filter(template => template.isBuiltIn)).toHaveLength(8);
    expect(templates.filter(template => !template.isBuiltIn)).toHaveLength(1);
  });

  it('deletes only user templates', () => {
    const created = createTemplate({
      name: 'Delete Me',
      description: 'Disposable template',
      category: 'General',
      prompt: 'Do the thing',
      cronExpression: '0 * * * *',
      rendererType: 'plaintext',
    });

    db.prepare(`
      INSERT INTO automation_templates (id, name, description, category, prompt, cron_expression, renderer_type, is_built_in, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'builtin-db',
      'Protected Template',
      'Cannot delete',
      'General',
      'Protected',
      '* * * * *',
      'plaintext',
      1,
      null,
    );

    expect(deleteTemplate(created.id)).toBe(true);
    expect(deleteTemplate('missing')).toBe(false);
    expect(deleteTemplate('builtin-db')).toBe(false);
    expect(db.prepare('SELECT id FROM automation_templates WHERE id = ?').get('builtin-db')).toBeTruthy();
  });
});
