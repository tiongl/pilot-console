import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { parse } from 'url';
import { requireAuth, SESSION_COOKIE, createSession, destroySession, getUserFromToken } from './middleware/auth';
import { getGitHubCliProfile } from '../shared/gh-cli-auth';
import { upsertUser, listUsers, updateUserRole, deleteUser } from '../shared/user-store';
import { createProject, listProjects, getProjectById, updateProject, deleteProject, addSkill, listSkills, updateSkill, deleteSkill, listWorktrees, createWorktree, getWorktreeById, deleteWorktree } from '../shared/project-store';
import { listSessionsForUser, listAllSessions, getCopilotSessionDetail, listCopilotSessionsForProject } from '../shared/session-store';
import { setupWebSocketServer } from './websocket';
import { getAllSessions, getAllSessionsWithExited, getSessionStatus, endCliSession, endSessionByProject, initDaemonBridge } from '../shared/cli-bridge';
import { getDb } from '../shared/db';
import scheduleRoutes from './routes/schedules';
import { startScheduler } from './scheduler';
import './renderers'; // register built-in renderers

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Auth routes (no auth required)
// ---------------------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    const profile = await getGitHubCliProfile();
    if (!profile) {
      res.status(401).json({ error: 'GitHub CLI not authenticated. Run: gh auth login' });
      return;
    }
    const user = upsertUser(String(profile.id), profile.login, profile.email ?? null, profile.name ?? null);
    const token = createSession(user.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) destroySession(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const user = getUserFromToken(token);
  if (!user) {
    res.clearCookie(SESSION_COOKIE);
    res.status(401).json({ error: 'Session expired' });
    return;
  }
  res.json({ user });
});

// ---------------------------------------------------------------------------
// Protected API routes
// ---------------------------------------------------------------------------
app.use('/api', requireAuth);

// --- Projects ---
app.get('/api/projects', (req, res) => {
  const db = getDb();
  const projects = db.prepare('SELECT id, name, repo_path as repoPath, description, pinned, sort_order as sortOrder, created_at as createdAt FROM projects ORDER BY pinned DESC, sort_order, name').all();
  res.json({ projects });
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, repoPath, description } = req.body;
    const project = createProject(name, repoPath, description);
    res.status(201).json(project);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(project);
});

app.patch('/api/projects/:id', (req, res) => {
  try {
    const project = updateProject(req.params.id, req.body);
    res.json(project);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  deleteProject(req.params.id);
  res.json({ ok: true });
});

// --- Worktrees ---
app.get('/api/projects/:id/worktrees', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ worktrees: listWorktrees(req.params.id) });
});

app.post('/api/projects/:id/worktrees', (req, res) => {
  const { name, branch, createNewBranch } = req.body as { name?: string; branch?: string; createNewBranch?: boolean };
  if (!name?.trim() || !branch?.trim()) {
    res.status(400).json({ error: 'name and branch are required' });
    return;
  }
  try {
    const wt = createWorktree(req.params.id, name.trim(), branch.trim(), createNewBranch ?? false);
    res.status(201).json(wt);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/projects/:id/worktrees/:worktreeId', (req, res) => {
  const wt = getWorktreeById(req.params.worktreeId);
  if (!wt || wt.projectId !== req.params.id) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(wt);
});

app.delete('/api/projects/:id/worktrees/:worktreeId', (req, res) => {
  try {
    deleteWorktree(req.params.worktreeId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// --- Sessions ---
app.get('/api/sessions/active', (req, res) => {
  const sessions = getAllSessionsWithExited()
    .filter((s) => s.projectId)
    .map((s) => ({
      projectId: s.projectId!,
      worktreeId: s.worktreeId ?? null,
      sessionId: s.sessionId,
      status: getSessionStatus(s),
      exitCode: s.lastExitCode,
    }));
  res.json({ sessions });
});

app.delete('/api/projects/:id/session', (req, res) => {
  const projectId = req.params.id;
  const sessionId = req.query.sessionId as string | undefined;
  if (sessionId) {
    endCliSession(sessionId);
    res.json({ ok: true });
  } else {
    const session = getAllSessions().find((s) => s.alive && s.projectId === projectId);
    if (session) {
      endSessionByProject(session.userId, projectId);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'No active session' });
    }
  }
});

app.get('/api/projects/:id/sessions', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const search = (req.query.search as string) || undefined;
  const sessions = listCopilotSessionsForProject(project.repoPath, 50, search);
  res.json({ sessions });
});

app.get('/api/sessions/:id/transcript', (req, res) => {
  const detail = getCopilotSessionDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(detail);
});

// --- Skills ---
app.get('/api/projects/:id/skills', (req, res) => {
  res.json(listSkills(req.params.id));
});

app.post('/api/projects/:id/skills', (req, res) => {
  try {
    const { type, name, config } = req.body;
    const skill = addSkill(req.params.id, type, name, config || {});
    res.status(201).json(skill);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/projects/:id/skills/:skillId', (req, res) => {
  try {
    const skill = updateSkill(req.params.skillId, req.body);
    res.json(skill);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/projects/:id/skills/:skillId', (req, res) => {
  deleteSkill(req.params.skillId);
  res.json({ ok: true });
});

// --- Todos ---
app.get('/api/projects/:id/todos', (req, res) => {
  const db = getDb();
  const todos = db.prepare('SELECT id, project_id as projectId, parent_id as parentId, text, done, position, created_at as createdAt FROM project_todos WHERE project_id = ? ORDER BY position').all(req.params.id);
  res.json({ todos });
});

app.post('/api/projects/:id/todos', (req, res) => {
  const db = getDb();
  const id = crypto.randomUUID();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM project_todos WHERE project_id = ? AND parent_id IS ?').get(req.params.id, req.body.parentId || null) as { maxPos: number };
  db.prepare('INSERT INTO project_todos (id, project_id, parent_id, text, position) VALUES (?, ?, ?, ?, ?)').run(id, req.params.id, req.body.parentId || null, req.body.text || '', (maxPos?.maxPos ?? -1) + 1);
  res.status(201).json({ id });
});

app.patch('/api/projects/:id/todos/:todoId', (req, res) => {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (req.body.text !== undefined) { sets.push('text = ?'); vals.push(req.body.text); }
  if (req.body.done !== undefined) { sets.push('done = ?'); vals.push(req.body.done ? 1 : 0); }
  if (req.body.parentId !== undefined) { sets.push('parent_id = ?'); vals.push(req.body.parentId); }
  if (req.body.position !== undefined) { sets.push('position = ?'); vals.push(req.body.position); }
  if (sets.length > 0) {
    vals.push(req.params.todoId, req.params.id);
    db.prepare(`UPDATE project_todos SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`).run(...vals);
  }
  res.json({ ok: true });
});

app.delete('/api/projects/:id/todos/:todoId', (req, res) => {
  getDb().prepare('DELETE FROM project_todos WHERE id = ? AND project_id = ?').run(req.params.todoId, req.params.id);
  res.json({ ok: true });
});

// --- Snippets ---
app.get('/api/projects/:id/snippets', (req, res) => {
  const db = getDb();
  const snippets = db.prepare('SELECT id, project_id as projectId, title, content, created_at as createdAt FROM project_snippets WHERE project_id = ? OR project_id IS NULL ORDER BY created_at DESC').all(req.params.id);
  res.json({ snippets });
});

app.post('/api/projects/:id/snippets', (req, res) => {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO project_snippets (id, project_id, title, content) VALUES (?, ?, ?, ?)').run(id, req.body.global ? null : req.params.id, req.body.title || 'Untitled', req.body.content || '');
  res.status(201).json({ id });
});

app.delete('/api/snippets/:id', (req, res) => {
  getDb().prepare('DELETE FROM project_snippets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Git ---
app.get('/api/projects/:id/git-status', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  try {
    const opts = { cwd: project.repoPath, encoding: 'utf-8' as const, timeout: 5000 };
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const status = execSync('git status --porcelain', opts).trim();
    const diffStat = execSync('git diff --stat', opts).trim();
    const files = status ? status.split('\n').map(line => ({
      status: line.substring(0, 2).trim(),
      path: line.substring(3),
    })) : [];
    res.json({ branch, files, diffStat });
  } catch (err) {
    res.status(500).json({ error: 'Git command failed', message: String(err) });
  }
});

app.get('/api/projects/:id/git-diff', (req, res) => {
  const filePath = req.query.file as string;
  const project = getProjectById(req.params.id);
  if (!project || !filePath) { res.status(400).json({ error: 'Missing project or file' }); return; }
  try {
    const opts = { cwd: project.repoPath, encoding: 'utf-8' as const, timeout: 5000 };
    let diff = '';
    try { diff = execSync(`git diff -- "${filePath}"`, opts).trim(); } catch {}
    if (!diff) {
      try { diff = execSync(`git diff --cached -- "${filePath}"`, opts).trim(); } catch {}
    }
    res.json({ diff: diff || 'No changes' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/projects/:id/git-log', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
  const skip = (page - 1) * limit;
  try {
    const opts = { cwd: project.repoPath, encoding: 'utf-8' as const, timeout: 10000, maxBuffer: 2 * 1024 * 1024 };
    // Use a unique delimiter to parse fields reliably
    const SEP = '<<GCL_SEP>>';
    const END = '<<GCL_END>>';
    const format = [`%H`, `%h`, `%an`, `%ae`, `%aI`, `%s`].join(SEP) + END;
    const raw = execSync(
      `git log --format="${format}" --skip=${skip} --max-count=${limit + 1}`,
      opts,
    ).trim();
    if (!raw) { res.json({ commits: [], hasMore: false }); return; }
    const lines = raw.split(END).filter(l => l.trim());
    const hasMore = lines.length > limit;
    const commits = lines.slice(0, limit).map(line => {
      const [hash, shortHash, author, authorEmail, date, message] = line.trim().split(SEP);
      return { hash, shortHash, author, authorEmail, date, message };
    });
    res.json({ commits, hasMore, page });
  } catch (err) {
    res.status(500).json({ error: 'Git log failed', message: String(err) });
  }
});

app.get('/api/projects/:id/git-commit/:hash', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const hash = req.params.hash.replace(/[^a-fA-F0-9]/g, '');
  if (!hash) { res.status(400).json({ error: 'Invalid hash' }); return; }
  try {
    const opts = { cwd: project.repoPath, encoding: 'utf-8' as const, timeout: 10000, maxBuffer: 2 * 1024 * 1024 };
    const SEP = '<<GCL_SEP>>';
    const format = [`%H`, `%h`, `%an`, `%ae`, `%aI`, `%B`].join(SEP);
    const meta = execSync(`git show -s --format="${format}" ${hash}`, opts).trim();
    const [commitHash, shortHash, author, authorEmail, date, ...msgParts] = meta.split(SEP);
    const message = msgParts.join(SEP).trim();

    // Get changed files
    let filesRaw = '';
    try { filesRaw = execSync(`git diff-tree --no-commit-id -r --name-status ${hash}`, opts).trim(); } catch {}
    const files = filesRaw ? filesRaw.split('\n').map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.trim(), path: pathParts.join('\t') };
    }) : [];

    res.json({ hash: commitHash, shortHash, author, authorEmail, date, message, files });
  } catch (err) {
    res.status(500).json({ error: 'Git commit detail failed', message: String(err) });
  }
});

app.get('/api/projects/:id/git-commit/:hash/diff', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const hash = req.params.hash.replace(/[^a-fA-F0-9]/g, '');
  if (!hash) { res.status(400).json({ error: 'Invalid hash' }); return; }
  const filePath = req.query.file as string | undefined;
  try {
    const opts = { cwd: project.repoPath, encoding: 'utf-8' as const, timeout: 10000, maxBuffer: 5 * 1024 * 1024 };
    const fileArg = filePath ? ` -- "${filePath}"` : '';
    const diff = execSync(`git show --format="" ${hash}${fileArg}`, opts).trim();
    res.json({ diff: diff || 'No changes' });
  } catch (err) {
    res.status(500).json({ error: 'Git diff failed', message: String(err) });
  }
});

// --- Project File Explorer ---
app.get('/api/projects/:id/files', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const relDir = (req.query.path as string) || '';
  const absDir = path.resolve(project.repoPath, relDir);
  // Security: ensure resolved path is within the project
  if (!absDir.startsWith(path.resolve(project.repoPath))) {
    res.status(403).json({ error: 'Access denied' }); return;
  }
  try {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' as const : 'file' as const,
        size: e.isFile() ? fs.statSync(path.join(absDir, e.name)).size : undefined,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
    res.json({ path: relDir, items });
  } catch {
    res.status(400).json({ error: 'Cannot read directory' });
  }
});

app.get('/api/projects/:id/files-search', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const query = (req.query.q as string || '').trim();
  if (!query) { res.json({ results: [] }); return; }
  // Convert glob pattern to regex: ** -> .*, * -> [^/]*, ? -> .
  // Handle ** before escaping special chars
  const withGlobstar = query.replace(/\*\*/g, '\x00GLOBSTAR\x00');
  const escaped = withGlobstar.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\x00GLOBSTAR\x00/g, '.*');
  let regex: RegExp;
  try { regex = new RegExp(regexStr, 'i'); } catch { res.json({ results: [] }); return; }

  const results: { path: string; type: 'file' | 'dir'; size?: number }[] = [];
  const MAX_RESULTS = 200;
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'coverage']);

  function walk(dir: string, rel: string) {
    if (results.length >= MAX_RESULTS) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= MAX_RESULTS) return;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (regex.test(relPath) || regex.test(e.name)) {
          results.push({ path: relPath, type: 'dir' });
        }
        walk(path.join(dir, e.name), relPath);
      } else if (e.isFile()) {
        if (regex.test(relPath) || regex.test(e.name)) {
          try {
            const size = fs.statSync(path.join(dir, e.name)).size;
            results.push({ path: relPath, type: 'file', size });
          } catch {
            results.push({ path: relPath, type: 'file' });
          }
        }
      }
    }
  }
  walk(path.resolve(project.repoPath), '');
  res.json({ results, truncated: results.length >= MAX_RESULTS });
});

app.get('/api/projects/:id/file', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
  const absPath = path.resolve(project.repoPath, filePath);
  if (!absPath.startsWith(path.resolve(project.repoPath))) {
    res.status(403).json({ error: 'Access denied' }); return;
  }
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) { res.status(400).json({ error: 'Not a file' }); return; }
    const MAX_FILE_SIZE = 512 * 1024; // 512KB
    if (stat.size > MAX_FILE_SIZE) {
      res.json({ path: filePath, truncated: true, size: stat.size, content: fs.readFileSync(absPath, 'utf-8').slice(0, MAX_FILE_SIZE) });
      return;
    }
    // Try to read as text; if it fails or looks binary, report it
    const buf = fs.readFileSync(absPath);
    const isBinary = buf.includes(0);
    if (isBinary) {
      res.json({ path: filePath, binary: true, size: stat.size });
      return;
    }
    res.json({ path: filePath, content: buf.toString('utf-8'), size: stat.size });
  } catch {
    res.status(400).json({ error: 'Cannot read file' });
  }
});

app.get('/api/projects/:id/file-raw', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
  const absPath = path.resolve(project.repoPath, filePath);
  if (!absPath.startsWith(path.resolve(project.repoPath))) {
    res.status(403).json({ error: 'Access denied' }); return;
  }
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) { res.status(400).json({ error: 'Not a file' }); return; }
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const mimeTypes: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
      pdf: 'application/pdf',
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(absPath).pipe(res);
  } catch {
    res.status(400).json({ error: 'Cannot read file' });
  }
});

// PUT endpoint - Edit existing file
app.put('/api/projects/:id/file', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const { path: filePath, content } = req.body;
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' }); return;
  }
  const absPath = path.resolve(project.repoPath, filePath);
  if (!absPath.startsWith(path.resolve(project.repoPath))) {
    res.status(403).json({ error: 'Access denied' }); return;
  }
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      res.status(404).json({ error: 'File not found' }); return;
    }
    const MAX_WRITE_SIZE = 1024 * 1024; // 1MB
    if (Buffer.byteLength(content) > MAX_WRITE_SIZE) {
      res.status(413).json({ error: 'Content too large (max 1MB)' }); return;
    }
    fs.writeFileSync(absPath, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file' });
  }
});

// POST endpoint - Create new file
app.post('/api/projects/:id/file', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const { path: filePath, content } = req.body;
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' }); return;
  }
  const absPath = path.resolve(project.repoPath, filePath);
  if (!absPath.startsWith(path.resolve(project.repoPath))) {
    res.status(403).json({ error: 'Access denied' }); return;
  }
  try {
    if (fs.existsSync(absPath)) {
      res.status(409).json({ error: 'File already exists' }); return;
    }
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create file' });
  }
});

// --- Browse ---
app.get('/api/browse', (req, res) => {
  const dirParam = (req.query.dir as string) || os.homedir();
  const dir = path.resolve(dirParam);
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) { res.status(400).json({ error: 'Not a directory' }); return; }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const isGitRepo = fs.existsSync(path.join(dir, '.git'));
    res.json({ path: dir, dirs, isGitRepo, parent: path.dirname(dir) });
  } catch {
    res.status(400).json({ error: 'Cannot read directory' });
  }
});

// --- Copilot Config ---
const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const SETTINGS_PATH = path.join(COPILOT_DIR, 'settings.json');
const MCP_CONFIG_PATH = path.join(COPILOT_DIR, 'mcp-config.json');

function readJsonFile(filePath: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return {}; }
}

function readMcpConfig(): Record<string, unknown> {
  const config = readJsonFile(MCP_CONFIG_PATH);
  return (config.mcpServers as Record<string, unknown>) || {};
}

function writeMcpConfig(mcpServers: Record<string, unknown>) {
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
}

app.get('/api/copilot-config', (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  const settings = readJsonFile(SETTINGS_PATH);
  const mcpConfig = readJsonFile(MCP_CONFIG_PATH);

  interface InstalledPlugin { name: string; marketplace: string; version: string; enabled: boolean; cache_path: string; }
  interface PluginSkill { name: string; path: string; }

  function getPluginSkills(cachePath: string): PluginSkill[] {
    const skillsDir = path.join(cachePath, 'skills');
    if (!fs.existsSync(skillsDir)) return [];
    try {
      return fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(skillsDir, e.name) }));
    } catch { return []; }
  }

  const installedPlugins = (settings.installedPlugins as InstalledPlugin[]) || [];
  const enabledPlugins = (settings.enabledPlugins as Record<string, boolean>) || {};

  const plugins = installedPlugins.map((p) => {
    const key = `${p.name}@${p.marketplace}`;
    const enabled = enabledPlugins[key] ?? p.enabled ?? false;
    return { name: p.name, marketplace: p.marketplace, version: p.version, enabled, skills: getPluginSkills(p.cache_path) };
  });

  const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) || {};

  let repoSkills: { agentsMd: boolean; customInstructions: string[] } = { agentsMd: false, customInstructions: [] };
  if (projectId) {
    const project = getProjectById(projectId);
    if (project) {
      repoSkills.agentsMd = fs.existsSync(path.join(project.repoPath, 'AGENTS.md'));
      const copilotDir = path.join(project.repoPath, '.github', 'copilot');
      if (fs.existsSync(copilotDir)) {
        try { repoSkills.customInstructions = fs.readdirSync(copilotDir).filter((f) => f.endsWith('.md')); } catch {}
      }
    }
  }

  res.json({ plugins, mcpServers, repoSkills });
});

app.put('/api/copilot-config/mcp', (req, res) => {
  writeMcpConfig(req.body.mcpServers || {});
  res.json({ ok: true });
});

app.post('/api/copilot-config/mcp', (req, res) => {
  const servers = readMcpConfig();
  servers[req.body.name] = req.body.config;
  writeMcpConfig(servers);
  res.json({ ok: true });
});

app.delete('/api/copilot-config/mcp', (req, res) => {
  const name = req.query.name as string;
  if (!name) { res.status(400).json({ error: 'Missing name' }); return; }
  const servers = readMcpConfig();
  delete servers[name];
  writeMcpConfig(servers);
  res.json({ ok: true });
});

app.get('/api/copilot-config/agents-md', (req, res) => {
  const projectId = req.query.projectId as string;
  if (!projectId) { res.status(400).json({ error: 'Missing projectId' }); return; }
  const project = getProjectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const agentsPath = path.join(project.repoPath, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) { res.status(404).json({ error: 'AGENTS.md not found' }); return; }
  const content = fs.readFileSync(agentsPath, 'utf-8');
  res.json({ content });
});

// --- Skill Catalog ---
app.get('/api/skill-catalog/marketplaces', (req, res) => {
  try {
    const raw = execSync('gh copilot plugin marketplace list', { encoding: 'utf-8', timeout: 15000 });
    const marketplaces: { name: string; source: string; builtin: boolean }[] = [];
    let builtinSection = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (/included with/i.test(trimmed)) { builtinSection = true; continue; }
      if (/registered marketplace/i.test(trimmed)) { builtinSection = false; continue; }
      const m = trimmed.match(/^\S+\s+([\w-]+)\s+\((?:GitHub:\s*)?([^)]+)\)/);
      if (!m) continue;
      marketplaces.push({ name: m[1], source: m[2], builtin: builtinSection });
    }
    res.json({ marketplaces });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/skill-catalog/browse', (req, res) => {
  const marketplace = req.query.marketplace as string;
  if (!marketplace) { res.status(400).json({ error: 'Missing marketplace' }); return; }
  try {
    const raw = execSync(`gh copilot plugin marketplace browse ${marketplace}`, { encoding: 'utf-8', timeout: 30000 });
    const plugins: { name: string; description: string }[] = [];
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^\S+\s+([\w-]+)\s+-\s+(.+)/);
      if (m) plugins.push({ name: m[1], description: m[2].trim() });
    }
    res.json({ plugins, marketplace });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/skill-catalog/installed', (req, res) => {
  try {
    const raw = execSync('gh copilot plugin list', { encoding: 'utf-8', timeout: 15000 });
    const installed: { name: string; marketplace: string; version: string }[] = [];
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^\S+\s+([\w-]+)@([\w-]+)\s+\(v?([\d.]+)\)/);
      if (m) installed.push({ name: m[1], marketplace: m[2], version: m[3] });
    }
    res.json({ installed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/skill-catalog/install', (req, res) => {
  const { plugin, marketplace } = req.body;
  if (!plugin || !marketplace) { res.status(400).json({ error: 'Missing plugin or marketplace' }); return; }
  try {
    const output = execSync(`gh copilot plugin install ${plugin}@${marketplace}`, { encoding: 'utf-8', timeout: 60000 });
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/skill-catalog/uninstall', (req, res) => {
  const { plugin, marketplace } = req.body;
  if (!plugin || !marketplace) { res.status(400).json({ error: 'Missing plugin or marketplace' }); return; }
  try {
    const output = execSync(`gh copilot plugin uninstall ${plugin}@${marketplace}`, { encoding: 'utf-8', timeout: 30000 });
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/skill-catalog/marketplace/add', (req, res) => {
  const { repo } = req.body;
  if (!repo) { res.status(400).json({ error: 'Missing repo' }); return; }
  try {
    const output = execSync(`gh copilot plugin marketplace add ${repo}`, { encoding: 'utf-8', timeout: 30000 });
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Admin ---
app.get('/api/admin/users', requireAuth, (req, res) => {
  res.json(listUsers());
});

app.patch('/api/admin/users/:id', requireAuth, (req, res) => {
  updateUserRole(String(req.params.id), req.body.role);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, (req, res) => {
  deleteUser(String(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/sessions', requireAuth, (req, res) => {
  res.json(listAllSessions());
});

app.delete('/api/admin/sessions/:id', requireAuth, (req, res) => {
  endCliSession(String(req.params.id));
  res.json({ ok: true });
});

// --- Scheduled Reports ---
app.use('/api/admin', scheduleRoutes);

// --- Daemon management ---
app.get('/api/daemon/status', requireAuth, async (req, res) => {
  const { getDaemonClient } = await import('../daemon/client');
  const { DAEMON_SOCKET_PATH } = await import('../daemon/protocol');
  const net = await import('net');
  const client = getDaemonClient();

  // Fast path: client already connected
  if (client.isConnected) {
    try {
      const sessions = await client.listSessions();
      res.json({
        connected: true,
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          alive: s.alive,
          exitCode: s.exitCode,
          exitedAt: s.exitedAt,
          lastOutputAt: s.lastOutputAt,
          bufferLength: s.bufferLength,
          userId: s.meta?.userId ?? null,
          projectId: s.meta?.projectId ?? null,
          source: s.meta?.source ?? null,
        })),
      });
      return;
    } catch {
      // listSessions failed — fall through to probe
    }
  }

  // Probe: can we reach the daemon pipe?
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(DAEMON_SOCKET_PATH);
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 2000);
    probe.on('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true); });
    probe.on('error', () => { clearTimeout(timer); resolve(false); });
  });

  if (alive && !client.isConnected) {
    // Daemon is running but client isn't connected — try to connect
    try { await client.connect(false); } catch { /* ignore */ }
  }

  res.json({ connected: alive, sessions: [] });
});

app.post('/api/daemon/start', requireAuth, async (req, res) => {
  const { getDaemonClient } = await import('../daemon/client');
  const client = getDaemonClient();
  try {
    await client.connect(true); // auto-start daemon
    await initDaemonBridge();
    res.json({ ok: true, connected: client.isConnected });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/daemon/restart', requireAuth, async (req, res) => {
  const { getDaemonClient } = await import('../daemon/client');
  const client = getDaemonClient();
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  // Kill existing daemon by PID
  const pidPath = path.join(os.homedir(), '.clippy', 'daemon.pid');
  try {
    if (fs.existsSync(pidPath)) {
      const daemonPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (daemonPid && !isNaN(daemonPid)) {
        try { process.kill(daemonPid, 'SIGTERM'); } catch { /* already dead */ }
      }
      try { fs.unlinkSync(pidPath); } catch { /* ok */ }
    }
  } catch { /* ok */ }

  // Clean up secret and lock so the new daemon generates fresh ones
  const secretPath = path.join(os.homedir(), '.clippy', 'daemon.secret');
  const lockPath = path.join(os.homedir(), '.clippy', 'daemon.lock');
  try { fs.unlinkSync(secretPath); } catch { /* ok */ }
  try { fs.unlinkSync(lockPath); } catch { /* ok */ }

  // Disconnect and wait a moment for cleanup
  client.disconnect();
  await new Promise(r => setTimeout(r, 1000));

  // Reconnect (will auto-start a new daemon)
  try {
    await client.connect();
    // Re-initialize the bridge to recover sessions
    await initDaemonBridge();
    res.json({ ok: true, connected: client.isConnected });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/daemon/sessions/:id/buffer', requireAuth, async (req, res) => {
  const { getDaemonClient } = await import('../daemon/client');
  const client = getDaemonClient();
  try {
    const peeked = await client.peekSession(String(req.params.id));
    res.json({
      sessionId: peeked.sessionId,
      buffer: peeked.buffer,
      alive: peeked.alive,
      exitCode: peeked.exitCode,
      lastSeq: peeked.lastSeq,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete('/api/daemon/sessions/:id', requireAuth, async (req, res) => {
  const { getDaemonClient } = await import('../daemon/client');
  const client = getDaemonClient();
  try {
    await client.killSession(String(req.params.id));
    endCliSession(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Static files + SPA fallback
// ---------------------------------------------------------------------------
const clientDist = path.resolve(__dirname, '../../dist/client');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('{*path}', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      res.sendFile(path.join(clientDist, 'index.html'));
    }
  });
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const hostname = process.env.HOST ?? 'localhost';
const port = parseInt(process.env.PORT ?? '3001', 10);

const httpServer = createServer(app);

// WebSocket
const wss = setupWebSocketServer();
httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = parse(req.url!, true);
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(port, hostname, async () => {
  console.log(`> Ready on http://${hostname}:${port}`);
  // Connect to daemon and recover surviving sessions
  try {
    await initDaemonBridge();
    console.log('[server] Daemon bridge initialized successfully');
    // Start the report scheduler after daemon is ready
    startScheduler();
  } catch (err) {
    console.error('Failed to initialize daemon bridge:', err);
  }
});

export { app, httpServer };
