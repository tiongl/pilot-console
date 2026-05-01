import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.clippy');
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
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_worktrees_project_id ON worktrees(project_id);
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
}
