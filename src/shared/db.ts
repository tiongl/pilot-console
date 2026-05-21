import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.pilot-console');
const DB_PATH = path.join(DB_DIR, 'app.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      github_id    TEXT UNIQUE NOT NULL,
      github_login TEXT,
      email        TEXT,
      display_name TEXT,
      role         TEXT NOT NULL DEFAULT 'user',
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      repo_path   TEXT NOT NULL,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_skills (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      name       TEXT NOT NULL,
      config     TEXT NOT NULL DEFAULT '{}',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_project_skills_project_id ON project_skills(project_id);

    CREATE TABLE IF NOT EXISTS project_todos (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id  TEXT REFERENCES project_todos(id) ON DELETE CASCADE,
      text       TEXT NOT NULL DEFAULT '',
      done       INTEGER NOT NULL DEFAULT 0,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_project_todos_project_id ON project_todos(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_todos_parent_id ON project_todos(parent_id);

    CREATE TABLE IF NOT EXISTS cli_sessions (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id),
      copilot_session_id TEXT,
      started_at         TEXT DEFAULT (datetime('now')),
      ended_at           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cli_sessions_user_id ON cli_sessions(user_id);

    CREATE TABLE IF NOT EXISTS project_snippets (
      id         TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_project_snippets_project_id ON project_snippets(project_id);

    CREATE TABLE IF NOT EXISTS worktrees (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      branch        TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      is_managed    INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_worktrees_project_id ON worktrees(project_id);

    CREATE TABLE IF NOT EXISTS report_schedules (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      cron_expression   TEXT NOT NULL,
      renderer_type     TEXT NOT NULL DEFAULT 'plaintext',
      enabled           INTEGER NOT NULL DEFAULT 1,
      cwd               TEXT,
      max_runtime_ms    INTEGER NOT NULL DEFAULT 300000,
      max_runs_retained INTEGER NOT NULL DEFAULT 50,
      created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
      next_run_at       TEXT,
      last_started_at   TEXT,
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS report_runs (
      id              TEXT PRIMARY KEY,
      schedule_id     TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'pending',
      triggered_by    TEXT NOT NULL DEFAULT 'scheduler',
      started_at      TEXT,
      completed_at    TEXT,
      raw_output      TEXT,
      rendered_output TEXT,
      renderer_type   TEXT,
      exit_code       INTEGER,
      was_truncated   INTEGER NOT NULL DEFAULT 0,
      error           TEXT,
      prompt_snapshot TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_report_runs_schedule_id ON report_runs(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_report_runs_status ON report_runs(status);
  `);

  // Migrations: add columns that may not exist in older DBs
  const cols = db.pragma('table_info(cli_sessions)') as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('project_id')) {
    db.exec('ALTER TABLE cli_sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cli_sessions_project_id ON cli_sessions(project_id)');
  }

  // Migration: add output_log column
  const sessionCols = db.pragma('table_info(cli_sessions)') as Array<{ name: string }>;
  const sessionColNames = new Set(sessionCols.map((c) => c.name));
  if (!sessionColNames.has('output_log')) {
    db.exec('ALTER TABLE cli_sessions ADD COLUMN output_log TEXT');
  }

  // Migration: add pinned and sort_order columns to projects
  const projectCols = db.pragma('table_info(projects)') as Array<{ name: string }>;
  const projectColNames = new Set(projectCols.map((c) => c.name));
  if (!projectColNames.has('pinned')) {
    db.exec('ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (!projectColNames.has('sort_order')) {
    db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: distinguish app-created worktrees from existing worktrees attached by the user.
  const worktreeCols = db.pragma('table_info(worktrees)') as Array<{ name: string }>;
  const worktreeColNames = new Set(worktreeCols.map((c) => c.name));
  if (!worktreeColNames.has('is_managed')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN is_managed INTEGER NOT NULL DEFAULT 1');
  }

  // Migration: add type column to worktrees ('worktree' for git worktrees, 'directory' for plain folders)
  if (!worktreeColNames.has('type')) {
    db.exec("ALTER TABLE worktrees ADD COLUMN type TEXT NOT NULL DEFAULT 'worktree'");
  }

  // Migration: add daemon_session_id to report_runs
  const runCols = db.pragma('table_info(report_runs)') as Array<{ name: string }>;
  const runColNames = new Set(runCols.map((c) => c.name));
  if (!runColNames.has('daemon_session_id')) {
    db.exec('ALTER TABLE report_runs ADD COLUMN daemon_session_id TEXT');
  }

  // Migration: add read column to report_runs
  if (!runColNames.has('read')) {
    db.exec('ALTER TABLE report_runs ADD COLUMN read INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: automation_templates table for user-saved templates
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_templates (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      category        TEXT NOT NULL DEFAULT 'General',
      prompt          TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      renderer_type   TEXT NOT NULL DEFAULT 'plaintext',
      is_built_in     INTEGER NOT NULL DEFAULT 0,
      created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
  `);
}
