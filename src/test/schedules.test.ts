import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ----------------------------------------------------------------
// Renderer registry tests
// ----------------------------------------------------------------
describe('Renderer registry', () => {
  // Reset module state between tests
  let registerRenderer: typeof import('../server/renderers/registry').registerRenderer;
  let render: typeof import('../server/renderers/registry').render;
  let getRendererTypes: typeof import('../server/renderers/registry').getRendererTypes;

  beforeEach(async () => {
    // Use dynamic import to get fresh module state
    vi.resetModules();
    const mod = await import('../server/renderers/registry');
    registerRenderer = mod.registerRenderer;
    render = mod.render;
    getRendererTypes = mod.getRendererTypes;
  });

  it('registers and retrieves renderer types', () => {
    registerRenderer('test', (raw) => raw.toUpperCase());
    expect(getRendererTypes()).toContain('test');
  });

  it('renders with registered renderer', () => {
    registerRenderer('upper', (raw) => raw.toUpperCase());
    expect(render('upper', 'hello')).toBe('HELLO');
  });

  it('falls back to raw output for unknown type', () => {
    expect(render('nonexistent', 'raw text')).toBe('raw text');
  });
});

// ----------------------------------------------------------------
// Built-in renderer tests
// ----------------------------------------------------------------
describe('Built-in renderers', () => {
  let render: typeof import('../server/renderers/registry').render;

  beforeEach(async () => {
    vi.resetModules();
    // Import built-in which registers renderers as a side effect
    await import('../server/renderers/built-in');
    const mod = await import('../server/renderers/registry');
    render = mod.render;
  });

  it('plaintext passes through unchanged', () => {
    expect(render('plaintext', 'hello world')).toBe('hello world');
  });

  it('markdown passes through unchanged', () => {
    const md = '# Title\n\n- item1\n- item2';
    expect(render('markdown', md)).toBe(md);
  });

  it('json pretty-prints valid JSON', () => {
    const input = '{"key":"value","n":42}';
    const result = render('json', input);
    expect(result).toContain('"key": "value"');
    expect(result).toContain('"n": 42');
  });

  it('json extracts fenced JSON blocks', () => {
    const input = 'Some text\n```json\n{"a":1}\n```\nMore text';
    const result = render('json', input);
    expect(result).toContain('"a": 1');
  });

  it('json returns raw output when no JSON found', () => {
    const input = 'Just plain text with no JSON';
    expect(render('json', input)).toBe(input);
  });
});

// ----------------------------------------------------------------
// Schedule store tests
// ----------------------------------------------------------------
describe('Schedule store', () => {
  // We need to mock better-sqlite3 for these tests since they use the DB
  let createSchedule: typeof import('../shared/schedule-store').createSchedule;
  let getScheduleById: typeof import('../shared/schedule-store').getScheduleById;
  let listSchedules: typeof import('../shared/schedule-store').listSchedules;
  let updateSchedule: typeof import('../shared/schedule-store').updateSchedule;
  let deleteSchedule: typeof import('../shared/schedule-store').deleteSchedule;
  let createRun: typeof import('../shared/schedule-store').createRun;
  let listRunsForSchedule: typeof import('../shared/schedule-store').listRunsForSchedule;
  let completeRun: typeof import('../shared/schedule-store').completeRun;
  let pruneOldRuns: typeof import('../shared/schedule-store').pruneOldRuns;
  let getDueSchedules: typeof import('../shared/schedule-store').getDueSchedules;

  let Database: any;
  let db: any;

  beforeEach(async () => {
    vi.resetModules();

    // Create an in-memory SQLite database
    const betterSqlite3 = await import('better-sqlite3');
    Database = betterSqlite3.default;
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create the tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        github_id TEXT UNIQUE NOT NULL,
        github_login TEXT,
        email TEXT,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS report_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        renderer_type TEXT NOT NULL DEFAULT 'plaintext',
        enabled INTEGER NOT NULL DEFAULT 1,
        cwd TEXT,
        max_runtime_ms INTEGER NOT NULL DEFAULT 300000,
        max_runs_retained INTEGER NOT NULL DEFAULT 50,
        created_by TEXT,
        next_run_at TEXT,
        last_started_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS report_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        triggered_by TEXT NOT NULL DEFAULT 'scheduler',
        started_at TEXT,
        completed_at TEXT,
        raw_output TEXT,
        rendered_output TEXT,
        renderer_type TEXT,
        exit_code INTEGER,
        was_truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        prompt_snapshot TEXT,
        daemon_session_id TEXT,
        read INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Mock getDb to return our in-memory database
    vi.doMock('../shared/db', () => ({
      getDb: () => db,
    }));

    const storeMod = await import('../shared/schedule-store');
    createSchedule = storeMod.createSchedule;
    getScheduleById = storeMod.getScheduleById;
    listSchedules = storeMod.listSchedules;
    updateSchedule = storeMod.updateSchedule;
    deleteSchedule = storeMod.deleteSchedule;
    createRun = storeMod.createRun;
    listRunsForSchedule = storeMod.listRunsForSchedule;
    completeRun = storeMod.completeRun;
    pruneOldRuns = storeMod.pruneOldRuns;
    getDueSchedules = storeMod.getDueSchedules;
  });

  afterEach(() => {
    db?.close();
  });

  it('creates and retrieves a schedule', () => {
    const schedule = createSchedule({
      name: 'Test Schedule',
      prompt: 'Summarize code',
      cronExpression: '0 9 * * *',
      rendererType: 'markdown',
    });

    expect(schedule.name).toBe('Test Schedule');
    expect(schedule.prompt).toBe('Summarize code');
    expect(schedule.cronExpression).toBe('0 9 * * *');
    expect(schedule.rendererType).toBe('markdown');
    expect(schedule.enabled).toBe(true);

    const retrieved = getScheduleById(schedule.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Test Schedule');
  });

  it('lists schedules', () => {
    createSchedule({ name: 'A', prompt: 'p1', cronExpression: '* * * * *' });
    createSchedule({ name: 'B', prompt: 'p2', cronExpression: '* * * * *' });

    const schedules = listSchedules();
    expect(schedules).toHaveLength(2);
  });

  it('updates a schedule', () => {
    const schedule = createSchedule({ name: 'Old', prompt: 'p', cronExpression: '* * * * *' });
    const updated = updateSchedule(schedule.id, { name: 'New', enabled: false });

    expect(updated.name).toBe('New');
    expect(updated.enabled).toBe(false);
  });

  it('deletes a schedule', () => {
    const schedule = createSchedule({ name: 'Delete Me', prompt: 'p', cronExpression: '* * * * *' });
    deleteSchedule(schedule.id);
    expect(getScheduleById(schedule.id)).toBeNull();
  });

  it('creates and completes a run', () => {
    const schedule = createSchedule({ name: 'S', prompt: 'p', cronExpression: '* * * * *' });
    const run = createRun({ scheduleId: schedule.id, triggeredBy: 'manual', promptSnapshot: 'p' });

    expect(run.status).toBe('running');
    expect(run.scheduleId).toBe(schedule.id);

    completeRun(run.id, {
      status: 'completed',
      rawOutput: 'output data',
      renderedOutput: 'rendered data',
      rendererType: 'plaintext',
      exitCode: 0,
      wasTruncated: false,
    });

    const runs = listRunsForSchedule(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
  });

  it('prunes old runs', () => {
    const schedule = createSchedule({ name: 'S', prompt: 'p', cronExpression: '* * * * *' });

    // Create 5 runs
    for (let i = 0; i < 5; i++) {
      const run = createRun({ scheduleId: schedule.id, triggeredBy: 'manual', promptSnapshot: `p${i}` });
      completeRun(run.id, {
        status: 'completed', rawOutput: `out${i}`, renderedOutput: `rend${i}`,
        rendererType: 'plaintext', exitCode: 0, wasTruncated: false,
      });
    }

    expect(listRunsForSchedule(schedule.id, 100)).toHaveLength(5);

    const pruned = pruneOldRuns(schedule.id, 2);
    expect(pruned).toBe(3);
    expect(listRunsForSchedule(schedule.id, 100)).toHaveLength(2);
  });

  it('getDueSchedules skips running and disabled', () => {
    const past = new Date(Date.now() - 60_000).toISOString();

    // Due schedule
    const s1 = createSchedule({ name: 'Due', prompt: 'p', cronExpression: '* * * * *', nextRunAt: past });

    // Disabled schedule
    const s2 = createSchedule({ name: 'Disabled', prompt: 'p', cronExpression: '* * * * *', nextRunAt: past });
    updateSchedule(s2.id, { enabled: false });

    // Schedule with running run
    const s3 = createSchedule({ name: 'Running', prompt: 'p', cronExpression: '* * * * *', nextRunAt: past });
    createRun({ scheduleId: s3.id, triggeredBy: 'scheduler', promptSnapshot: 'p' });

    const due = getDueSchedules();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe(s1.id);
  });
});

