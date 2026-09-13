import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { parse } from 'url';
import { requireAuth, SESSION_COOKIE, createSession, destroySession, getUserFromToken } from './middleware/auth';
import { getGitHubCliProfile } from '../shared/gh-cli-auth';
import {
  listMarketplaces as libListMarketplaces,
  browsePlugins as libBrowsePlugins,
  listInstalledPlugins as libListInstalledPlugins,
  installPlugin as libInstallPlugin,
  uninstallPlugin as libUninstallPlugin,
} from '../shared/skill-catalog';
import { upsertUser, listUsers, updateUserRole, deleteUser } from '../shared/user-store';
import { createProject, listProjects, getProjectById, updateProject, deleteProject, addSkill, listSkills, updateSkill, deleteSkill, listWorktrees, createWorktree, attachExistingWorktree, attachSubnode, getWorktreeById, consumeWorktreeSeed } from '../shared/project-store';
import { assessWorktreeCleanup, closeWorktree } from '../shared/worktree-cleanup';
import { createTodo, deleteTodo, listTodos, updateTodo } from '../shared/todo-store';
import { listSessionsForUser, listAllSessions, getCopilotSessionDetail, listCopilotSessionsForProject } from '../shared/session-store';
import { setupWebSocketServer } from './websocket';
import { setupAgentWebSocketServer } from './agent-websocket';
import { setupServerWebSocketServer } from './server-websocket';
import { listServersByProject, getServerById, deleteServer } from '../shared/server-store';
import { stopServer, restartServer, isServerActive } from '../shared/server-runtime';
import { listArtifactsByProject, getArtifactById, deleteArtifact } from '../shared/lavish-store';
import { stopLavishArtifact } from '../shared/lavish-runtime';
import { lavishProxyMiddleware, handleLavishUpgrade } from './lavish-proxy';
import { listAgentModels, detachAgentBridge, listLiveAgentSessions } from '../shared/agent-bridge';
import { getAllSessions, getAllSessionsWithExited, getSessionStatus, endCliSession, endSessionByProject, initDaemonBridge } from '../shared/cli-bridge';
import { getDb } from '../shared/db';
import { getDigest, listDigests, bootstrapDigest, reconcileDigest } from '../shared/digest-store';
import { listMergeRequests, getMergeRequest, setMergePriority, resolveMergeRequest, releaseMergeLock, getMergeLock, executeApprovedMerge } from '../shared/merge-store';
import { getOrBootstrapProjectMemory, refreshProjectMemory } from '../shared/project-memory-store';
import { listCosBriefings, listCosBriefingsForProject } from '../shared/cos-briefing-store';
import { listDelegations, listAllDelegations, clearDelegationUnread, unreadDelegationCounts } from '../shared/delegation-store';
import { revealPathInFileSystem } from './file-system';
import scheduleRoutes from './routes/schedules';
import githubRoutes from './routes/github';
import { startScheduler } from './scheduler';
import { startDelegationMonitor } from './delegation-monitor';
import { startLagMonitor, getPerfSnapshot, recordApiCall } from './perf-monitor';
import './renderers'; // register built-in renderers

const app = express();

// The Lavish reverse proxy must forward the RAW request body to the Lavish
// daemon, so it is mounted before express.json() (which would otherwise consume
// the body). It authenticates via the session cookie internally.
app.use('/api/lavish/:artifactId', lavishProxyMiddleware);

app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Slow API request tracing — tracks which endpoints block the event loop
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  const start = performance.now();
  const route = req.method + ' ' + req.originalUrl.split('?')[0];
  res.on('finish', () => {
    const dur = performance.now() - start;
    recordApiCall(route, dur);
  });
  next();
});

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

app.get('/api/chief-of-staff/overview', (_req, res) => {
  const db = getDb();
  const projects = db.prepare('SELECT id, name FROM projects ORDER BY name').all() as Array<{ id: string; name: string }>;
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const workers = listLiveAgentSessions()
    .filter((session) => session.kind === 'agent' && session.worktreeId)
    .map((session) => ({
      ...session,
      projectName: session.projectId ? projectNames.get(session.projectId) ?? session.projectId : 'Unknown project',
    }));
  const leadSessions = listLiveAgentSessions()
    .filter((session) => session.kind === 'project_lead')
    .map((session) => ({
      ...session,
      projectName: session.projectId ? projectNames.get(session.projectId) ?? session.projectId : 'Unknown project',
    }));
  const digests = db.prepare(`
    SELECT d.worktree_id as worktreeId, d.project_id as projectId, w.name as worktreeName,
           d.headline, d.status, d.detail, d.updated_at as updatedAt
    FROM agent_digests d
    JOIN worktrees w ON w.id = d.worktree_id
    ORDER BY d.updated_at DESC
    LIMIT 50
  `).all() as Array<Record<string, unknown>>;
  const threads = db.prepare(`
    SELECT dt.id, dt.project_id as projectId, p.name as projectName, dt.title,
           dt.question, dt.status, dt.updated_at as updatedAt
    FROM decision_threads dt
    JOIN projects p ON p.id = dt.project_id
    WHERE dt.status NOT IN ('confirmed', 'closed', 'resolved')
    ORDER BY dt.updated_at DESC
    LIMIT 25
  `).all();
  const history = db.prepare(`
    SELECT a.id, a.project_id as projectId, p.name as projectName, a.actor,
           a.action, a.reasoning, a.risk_level as riskLevel, a.subject_id as subjectId, a.created_at as createdAt
    FROM project_audit_log a
    JOIN projects p ON p.id = a.project_id
    ORDER BY a.created_at DESC
    LIMIT 25
  `).all();
  const briefings = listCosBriefings(25);
  res.json({ workers, leadSessions, digests, threads, history, briefings });
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
  const { name, branch, createNewBranch, worktreePath, type } = req.body as { name?: string; branch?: string; createNewBranch?: boolean; worktreePath?: string; type?: string };

  // Plain directory subnode (non-git)
  if (type === 'directory') {
    if (!worktreePath?.trim()) {
      res.status(400).json({ error: 'worktreePath is required for directory subnodes' });
      return;
    }
    try {
      const wt = attachSubnode(req.params.id, name, worktreePath);
      res.status(201).json(wt);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
    return;
  }

  // Attach existing git worktree
  if (worktreePath?.trim()) {
    try {
      const wt = attachExistingWorktree(req.params.id, name, worktreePath, branch);
      res.status(201).json(wt);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
    return;
  }
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

app.get('/api/projects/:id/digests', (req, res) => {
  try {
    const digests = listDigests(req.params.id);
    res.json({ digests });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.get('/api/projects/:id/audit-log', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const entries = getDb().prepare(
    'SELECT * FROM project_audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(req.params.id, limit);
  res.json({ entries });
});

app.get('/api/projects/:id/delegations', requireAuth, (req, res) => {
  const projectId = String(req.params.id);
  const project = getProjectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ delegations: listDelegations(projectId) });
});

app.post('/api/projects/:id/delegations/:delegationId/read', requireAuth, (req, res) => {
  const project = getProjectById(String(req.params.id));
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  clearDelegationUnread(String(req.params.delegationId));
  res.json({ ok: true });
});

app.get('/api/delegations/unread', requireAuth, (_req, res) => {
  res.json({ counts: unreadDelegationCounts() });
});

app.get('/api/delegations', requireAuth, (_req, res) => {
  res.json({ delegations: listAllDelegations() });
});

// --- Managed servers (Project Lead "start server" feature) ---
app.get('/api/projects/:id/servers', requireAuth, (req, res) => {
  const projectId = String(req.params.id);
  const project = getProjectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const servers = listServersByProject(projectId).map((s) => ({
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    command: s.command,
    status: s.status,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    createdAt: s.createdAt,
    running: isServerActive(s.id),
  }));
  res.json({ servers });
});

app.post('/api/servers/:serverId/stop', requireAuth, (req, res) => {
  const server = getServerById(String(req.params.serverId));
  if (!server) { res.status(404).json({ error: 'Server not found' }); return; }
  stopServer(server.id);
  res.json({ ok: true, serverId: server.id });
});

app.post('/api/servers/:serverId/restart', requireAuth, async (req, res) => {
  const server = getServerById(String(req.params.serverId));
  if (!server) { res.status(404).json({ error: 'Server not found' }); return; }
  try {
    const result = await restartServer(req.user?.id ?? '', server.id);
    res.json({ ok: true, serverId: server.id, status: result.status });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/servers/:serverId', requireAuth, (req, res) => {
  const server = getServerById(String(req.params.serverId));
  if (!server) { res.status(404).json({ error: 'Server not found' }); return; }
  if (isServerActive(server.id)) stopServer(server.id);
  deleteServer(server.id);
  res.json({ ok: true, serverId: server.id });
});

// --- Lavish artifacts (Project Lead "open artifact" live-embed feature) ---
app.get('/api/projects/:id/lavish', requireAuth, (req, res) => {
  const projectId = String(req.params.id);
  const project = getProjectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const artifacts = listArtifactsByProject(projectId).map((a) => ({
    id: a.id,
    projectId: a.projectId,
    name: a.name,
    status: a.status,
    sessionKey: a.sessionKey,
    proxyPath: a.sessionKey ? `/api/lavish/${a.id}/session/${a.sessionKey}` : null,
    createdAt: a.createdAt,
  }));
  res.json({ artifacts });
});

app.delete('/api/lavish-artifacts/:artifactId', requireAuth, (req, res) => {
  const artifact = getArtifactById(String(req.params.artifactId));
  if (!artifact) { res.status(404).json({ error: 'Artifact not found' }); return; }
  stopLavishArtifact(artifact.id);
  deleteArtifact(artifact.id);
  res.json({ ok: true, artifactId: artifact.id });
});

app.get('/api/projects/:id/memory', (req, res) => {  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(getOrBootstrapProjectMemory(req.params.id));
});

app.post('/api/projects/:id/memory/refresh', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(refreshProjectMemory(req.params.id));
});

app.get('/api/projects/:id/briefings', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ briefings: listCosBriefingsForProject(req.params.id) });
});

app.get('/api/projects/:id/decision-threads', requireAuth, (req, res) => {
  const projectId = String(req.params.id);
  const project = getProjectById(projectId);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const threads = search
    ? getDb().prepare(`
        SELECT * FROM decision_threads
        WHERE project_id = ? AND (title LIKE ? OR question LIKE ? OR decision LIKE ?)
        ORDER BY updated_at DESC
      `).all(projectId, `%${search}%`, `%${search}%`, `%${search}%`)
    : getDb().prepare(
        'SELECT * FROM decision_threads WHERE project_id = ? ORDER BY updated_at DESC',
      ).all(projectId);
  res.json({ threads });
});

app.patch('/api/projects/:id/decision-threads/:threadId', requireAuth, (req, res) => {
  const thread = getDb().prepare(
    'SELECT id FROM decision_threads WHERE id = ? AND project_id = ?',
  ).get(String(req.params.threadId), String(req.params.id));
  if (!thread) { res.status(404).json({ error: 'Decision thread not found' }); return; }
  const fields = req.body as {
    status?: string; decision?: string; rationale?: string; userVerdict?: string; followUpActions?: string;
  };
  getDb().prepare(`
    UPDATE decision_threads SET
      status = COALESCE(?, status),
      decision = COALESCE(?, decision),
      rationale = COALESCE(?, rationale),
      user_verdict = COALESCE(?, user_verdict),
      follow_up_actions = COALESCE(?, follow_up_actions),
      updated_at = datetime('now')
    WHERE id = ? AND project_id = ?
  `).run(
    fields.status ?? null,
    fields.decision ?? null,
    fields.rationale ?? null,
    fields.userVerdict ?? null,
    fields.followUpActions ?? null,
    String(req.params.threadId),
    String(req.params.id),
  );
  if (fields.status && fields.status !== 'open') refreshProjectMemory(String(req.params.id));
  const updated = getDb().prepare('SELECT * FROM decision_threads WHERE id = ?').get(String(req.params.threadId));
  res.json({ ok: true, thread: updated });
});

app.get('/api/projects/:id/autonomy', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const settings = getDb().prepare(
    'SELECT project_id as projectId, merge_mode as mergeMode, intervention_mode as interventionMode, skill_install_mode as skillInstallMode, dnd FROM project_autonomy_settings WHERE project_id = ?',
  ).get(req.params.id) ?? { projectId: req.params.id, mergeMode: 'advisory', interventionMode: 'flag_only', skillInstallMode: 'suggest_only', dnd: 0 };
  res.json({ settings });
});

app.patch('/api/projects/:id/autonomy', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const { mergeMode = 'advisory', interventionMode = 'flag_only', skillInstallMode = 'suggest_only', dnd = false } = req.body as {
    mergeMode?: string; interventionMode?: string; skillInstallMode?: string; dnd?: boolean;
  };
  if (!['advisory', 'auto_queue', 'full_auto'].includes(mergeMode) ||
      !['flag_only', 'flag_nudge', 'flag_nudge_cancel'].includes(interventionMode) ||
      !['suggest_only', 'approve_and_install'].includes(skillInstallMode)) {
    res.status(400).json({ error: 'Invalid autonomy settings' });
    return;
  }
  getDb().prepare(`
    INSERT INTO project_autonomy_settings (project_id, merge_mode, intervention_mode, skill_install_mode, dnd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      merge_mode = excluded.merge_mode,
      intervention_mode = excluded.intervention_mode,
      skill_install_mode = excluded.skill_install_mode,
      dnd = excluded.dnd
  `).run(req.params.id, mergeMode, interventionMode, skillInstallMode, dnd ? 1 : 0);
  res.json({ ok: true });
});

app.get('/api/merge-queue', (_req, res) => {
  res.json({ requests: listMergeRequests() });
});

app.get('/api/portfolio-alerts', (_req, res) => {
  const db = getDb();
  const rows: Array<{ projectId: string; projectName: string; kind: 'blocked' | 'stale' | 'merge' | 'decision'; label: string; detail: string }> = [];
  const projects = db.prepare('SELECT id, name FROM projects ORDER BY name').all() as Array<{ id: string; name: string }>;
  for (const project of projects) {
    const settings = db.prepare('SELECT dnd FROM project_autonomy_settings WHERE project_id = ?').get(project.id) as { dnd?: number } | undefined;
    if (settings?.dnd) continue;
    const digests = db.prepare(`
      SELECT headline, status, detail, updated_at as updatedAt
      FROM agent_digests WHERE project_id = ?
      AND status IN ('blocked', 'in_progress')
    `).all(project.id) as Array<{ headline: string | null; status: string; detail: string | null; updatedAt: string | null }>;
    for (const digest of digests) {
      const timestamp = digest.updatedAt ? new Date(`${digest.updatedAt.replace(' ', 'T')}Z`).getTime() : Date.now();
      if (digest.status === 'blocked') {
        rows.push({ projectId: project.id, projectName: project.name, kind: 'blocked', label: 'Blocked worktree', detail: digest.detail || digest.headline || 'A worktree reports a blocker.' });
      } else if (Date.now() - timestamp > 30 * 60 * 1000) {
        rows.push({ projectId: project.id, projectName: project.name, kind: 'stale', label: 'Stale activity', detail: digest.detail || digest.headline || 'No digest update in more than 30 minutes.' });
      }
    }
    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM merge_requests WHERE project_id = ? AND status IN ('pending', 'approved', 'conflict')",
    ).get(project.id) as { count: number };
    if (pending.count > 0) rows.push({ projectId: project.id, projectName: project.name, kind: 'merge', label: 'Merge queue', detail: `${pending.count} merge request${pending.count === 1 ? '' : 's'} need attention.` });
    const decisions = db.prepare(
      "SELECT COUNT(*) as count FROM decision_threads WHERE project_id = ? AND status = 'open'",
    ).get(project.id) as { count: number };
    if (decisions.count > 0) rows.push({ projectId: project.id, projectName: project.name, kind: 'decision', label: 'Open decision', detail: `${decisions.count} decision thread${decisions.count === 1 ? '' : 's'} awaiting a verdict.` });
  }
  res.json({ rows: rows.slice(0, 20) });
});

app.get('/api/projects/:id/merge-queue', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ requests: listMergeRequests(req.params.id) });
});

app.patch('/api/projects/:id/merge-queue/:requestId/priority', (req, res) => {
  try {
    const request = getMergeRequest(req.params.requestId);
    if (!request || request.projectId !== req.params.id) { res.status(404).json({ error: 'Merge request not found' }); return; }
    res.json(setMergePriority(request.id, req.body.priority));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/merge-queue/:requestId/approve', async (req, res) => {
  try {
    const request = getMergeRequest(req.params.requestId);
    if (!request || request.projectId !== req.params.id) { res.status(404).json({ error: 'Merge request not found' }); return; }
    resolveMergeRequest(request.id, 'approved', req.body.note);
    getDb().prepare(`
      INSERT INTO project_audit_log (id, project_id, actor, action, reasoning, risk_level)
      VALUES (?, ?, 'project_lead', 'approve_merge', ?, 'medium')
    `).run(crypto.randomUUID(), req.params.id, req.body.note ?? 'Approved merge request');
    res.json(await executeApprovedMerge(request.id));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/merge-queue/:requestId/reject', (req, res) => {
  try {
    const request = getMergeRequest(req.params.requestId);
    if (!request || request.projectId !== req.params.id) { res.status(404).json({ error: 'Merge request not found' }); return; }
    const resolved = resolveMergeRequest(request.id, 'rejected', req.body.reason);
    getDb().prepare(`
      INSERT INTO project_audit_log (id, project_id, actor, action, reasoning, risk_level)
      VALUES (?, ?, 'project_lead', 'reject_merge', ?, 'medium')
    `).run(crypto.randomUUID(), req.params.id, req.body.reason);
    res.json({ request: resolved });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/merge-lock/release', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  releaseMergeLock(req.params.id);
  getDb().prepare(`
    INSERT INTO project_audit_log (id, project_id, actor, action, reasoning, risk_level)
    VALUES (?, ?, 'user', 'force_release_merge_lock', ?, 'high')
  `).run(crypto.randomUUID(), req.params.id, req.body.reason ?? 'Merge lock force-released');
  res.json({ ok: true });
});

app.get('/api/projects/:id/merge-lock', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ lock: getMergeLock(req.params.id) });
});

app.get('/api/projects/:id/worktrees/:worktreeId/digest', (req, res) => {
  try {
    const digest = getDigest(req.params.worktreeId, req.params.id);
    res.json({ digest });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/worktrees/:worktreeId/digest/bootstrap', (req, res) => {
  try {
    const digest = getDigest(req.params.worktreeId, req.params.id) ?? bootstrapDigest(req.params.worktreeId);
    res.status(201).json({ digest });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/worktrees/:worktreeId/digest/reconcile', (req, res) => {
  try {
    const digest = getDigest(req.params.worktreeId, req.params.id);
    if (!digest) bootstrapDigest(req.params.worktreeId);
    res.json({ digest: reconcileDigest(req.params.worktreeId) });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/worktrees/:worktreeId/digest/spot-check', (req, res) => {
  try {
    const digest = getDigest(req.params.worktreeId, req.params.id);
    if (!digest) bootstrapDigest(req.params.worktreeId);
    const live = reconcileDigest(req.params.worktreeId);
    getDb().prepare(`
      INSERT INTO project_audit_log (id, project_id, actor, action, reasoning, risk_level)
      VALUES (?, ?, 'user', 'digest_spot_check', ?, 'low')
    `).run(
      crypto.randomUUID(),
      req.params.id,
      req.body?.reason ?? 'User requested a live digest spot-check',
    );
    res.json({ digest: live, checked: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// One-shot: return and clear a worktree's seed prompt (used to auto-start the
// Copilot CLI session for the issue the worktree was created for).
app.get('/api/projects/:id/worktrees/:worktreeId/seed', (req, res) => {
  const wt = getWorktreeById(req.params.worktreeId);
  if (!wt || wt.projectId !== req.params.id) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ seed: consumeWorktreeSeed(req.params.worktreeId) });
});

app.delete('/api/projects/:id/worktrees/:worktreeId', async (req, res) => {
  const projectId = String(req.params.id);
  const worktreeId = String(req.params.worktreeId);
  try {
    // The dialog spells out what will be lost, so a user-driven delete is
    // always allowed — but it still routes through closeWorktree so sessions
    // are released and delegations retired the same way the lead's are.
    const result = await closeWorktree(projectId, worktreeId, { force: true });
    res.json({ ok: true, closedSessions: result.closedSessions.length });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** What, if anything, stops this worktree being cleaned up. */
app.get('/api/projects/:id/worktrees/:worktreeId/cleanup-check', async (req, res) => {
  try {
    res.json(await assessWorktreeCleanup(String(req.params.id), String(req.params.worktreeId)));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
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
      mode: s.mode,
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

// --- Agent (SDK) mode ---
app.get('/api/agent/models', async (_req, res) => {
  try {
    const models = await listAgentModels();
    res.json({ models });
  } catch (err) {
    console.error('[api] failed to list agent models:', err);
    // `degraded` tells the client this is a placeholder, not the real catalog,
    // so it can retry instead of leaving the picker stuck on "Auto".
    res.status(503).json({ error: 'Copilot SDK unavailable', degraded: true, models: [{ id: 'auto', name: 'Auto' }] });
  }
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
  res.json({ todos: listTodos(req.params.id) });
});

app.post('/api/projects/:id/todos', (req, res) => {
  try {
    const todo = createTodo({
      projectId: req.params.id,
      text: typeof req.body.text === 'string' ? req.body.text : '',
      parentId: req.body.parentId ?? null,
    });
    res.status(201).json({ id: todo.id, todo });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.patch('/api/projects/:id/todos/:todoId', (req, res) => {
  try {
    const todo = updateTodo(req.params.id, req.params.todoId, req.body);
    if (!todo) return res.status(404).json({ error: 'Todo not found' });
    res.json({ ok: true, todo });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.delete('/api/projects/:id/todos/:todoId', (req, res) => {
  deleteTodo(req.params.id, req.params.todoId);
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

const execFileAsync = promisify(execFile);

/** Run a git command asynchronously — does NOT block the event loop. */
async function gitAsync(args: string[], cwd: string, timeoutMs = 5000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Check whether the cwd is inside a git repo (sync — only used in non-hot paths). */
function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd, encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Async version of isGitRepo. */
async function isGitRepoAsync(cwd: string): Promise<boolean> {
  try {
    await gitAsync(['rev-parse', '--git-dir'], cwd, 3000);
    return true;
  } catch {
    return false;
  }
}

/** Check whether the repo has at least one commit. */
function hasGitCommits(cwd: string): boolean {
  try {
    execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Async version of hasGitCommits. */
async function hasGitCommitsAsync(cwd: string): Promise<boolean> {
  try {
    await gitAsync(['rev-parse', 'HEAD'], cwd, 3000);
    return true;
  } catch {
    return false;
  }
}

app.get('/api/projects/:id/git-status', async (req, res) => {
  const result = getGitCwd(req.params.id, req.query.worktreeId);
  if ('error' in result) { res.status(result.status).json({ error: result.error }); return; }
  if (!await isGitRepoAsync(result.cwd)) { res.json({ branch: null, files: [], diffStat: '', noGit: true }); return; }
  try {
    let branch = '(no commits)';
    const hasCommits = await hasGitCommitsAsync(result.cwd);
    if (hasCommits) {
      branch = await gitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], result.cwd);
    }
    const status = await gitAsync(['status', '--porcelain'], result.cwd);
    let diffStat = '';
    if (hasCommits) {
      try { diffStat = await gitAsync(['diff', '--stat'], result.cwd); } catch {}
    }
    const files = status ? status.split('\n').map(line => ({
      status: line.substring(0, 2).trim(),
      path: line.substring(3),
    })) : [];
    res.json({ branch, files, diffStat });
  } catch (err) {
    res.status(500).json({ error: 'Git command failed', message: String(err) });
  }
});

app.get('/api/projects/:id/git-diff', async (req, res) => {
  const filePath = req.query.file as string;
  const result = getGitCwd(req.params.id, req.query.worktreeId);
  if ('error' in result) { res.status(result.status).json({ error: result.error }); return; }
  if (!filePath) { res.status(400).json({ error: 'Missing file' }); return; }
  if (!await isGitRepoAsync(result.cwd)) { res.json({ diff: 'Not a git repository' }); return; }
  try {
    let diff = '';
    try { diff = await gitAsync(['diff', '--', filePath], result.cwd); } catch {}
    if (!diff) {
      try { diff = await gitAsync(['diff', '--cached', '--', filePath], result.cwd); } catch {}
    }
    res.json({ diff: diff || 'No changes' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/projects/:id/git-log', async (req, res) => {
  const result = getGitCwd(req.params.id, req.query.worktreeId);
  if ('error' in result) { res.status(result.status).json({ error: result.error }); return; }
  if (!await isGitRepoAsync(result.cwd) || !await hasGitCommitsAsync(result.cwd)) {
    res.json({ commits: [], hasMore: false, noGit: !await isGitRepoAsync(result.cwd) });
    return;
  }
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
  const skip = (page - 1) * limit;
  try {
    const SEP = '<<GCL_SEP>>';
    const END = '<<GCL_END>>';
    const format = [`%H`, `%h`, `%an`, `%ae`, `%aI`, `%s`].join(SEP) + END;
    const raw = await gitAsync(
      ['log', `--format=${format}`, `--skip=${skip}`, `--max-count=${limit + 1}`],
      result.cwd, 10000,
    );
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

app.get('/api/projects/:id/git-commit/:hash', async (req, res) => {
  const result = getGitCwd(req.params.id, req.query.worktreeId);
  if ('error' in result) { res.status(result.status).json({ error: result.error }); return; }
  if (!await isGitRepoAsync(result.cwd) || !await hasGitCommitsAsync(result.cwd)) {
    res.status(404).json({ error: 'No git history available' });
    return;
  }
  const hash = req.params.hash.replace(/[^a-fA-F0-9]/g, '');
  if (!hash) { res.status(400).json({ error: 'Invalid hash' }); return; }
  try {
    const SEP = '<<GCL_SEP>>';
    const format = [`%H`, `%h`, `%an`, `%ae`, `%aI`, `%B`].join(SEP);
    const meta = await gitAsync(['show', '-s', `--format=${format}`, hash], result.cwd, 10000);
    const [commitHash, shortHash, author, authorEmail, date, ...msgParts] = meta.split(SEP);
    const message = msgParts.join(SEP).trim();

    let filesRaw = '';
    try { filesRaw = await gitAsync(['diff-tree', '--no-commit-id', '-r', '--name-status', hash], result.cwd, 10000); } catch {}
    const files = filesRaw ? filesRaw.split('\n').map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.trim(), path: pathParts.join('\t') };
    }) : [];

    res.json({ hash: commitHash, shortHash, author, authorEmail, date, message, files });
  } catch (err) {
    res.status(500).json({ error: 'Git commit detail failed', message: String(err) });
  }
});

app.get('/api/projects/:id/git-commit/:hash/diff', async (req, res) => {
  const result = getGitCwd(req.params.id, req.query.worktreeId);
  if ('error' in result) { res.status(result.status).json({ error: result.error }); return; }
  if (!await isGitRepoAsync(result.cwd) || !await hasGitCommitsAsync(result.cwd)) {
    res.status(404).json({ error: 'No git history available' });
    return;
  }
  const hash = req.params.hash.replace(/[^a-fA-F0-9]/g, '');
  if (!hash) { res.status(400).json({ error: 'Invalid hash' }); return; }
  const filePath = req.query.file as string | undefined;
  try {
    const args = ['show', '--format=', hash];
    if (filePath) args.push('--', filePath);
    const diff = await gitAsync(args, result.cwd, 10000);
    res.json({ diff: diff || 'No changes' });
  } catch (err) {
    res.status(500).json({ error: 'Git diff failed', message: String(err) });
  }
});

// --- Project File Explorer ---
function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolve the git working directory for a project, optionally scoped to a worktree. */
function getGitCwd(projectId: string, worktreeId: unknown): { cwd: string } | { status: number; error: string } {
  const project = getProjectById(projectId);
  if (!project) return { status: 404, error: 'Project not found' };
  if (typeof worktreeId === 'string' && worktreeId.trim()) {
    const wt = getWorktreeById(worktreeId);
    if (!wt || wt.projectId !== projectId) return { status: 404, error: 'Worktree not found' };
    return { cwd: path.resolve(wt.worktreePath) };
  }
  return { cwd: path.resolve(project.repoPath) };
}

function getFileExplorerRoot(projectId: string, worktreeId: unknown): { root: string } | { status: number; error: string } {
  const project = getProjectById(projectId);
  if (!project) return { status: 404, error: 'Project not found' };

  if (typeof worktreeId === 'string' && worktreeId.trim()) {
    const wt = getWorktreeById(worktreeId);
    if (!wt || wt.projectId !== projectId) return { status: 404, error: 'Worktree not found' };
    return { root: path.resolve(wt.worktreePath) };
  }

  return { root: path.resolve(project.repoPath) };
}

app.get('/api/projects/:id/files', (req, res) => {
  const rootResult = getFileExplorerRoot(req.params.id, req.query.worktreeId);
  if ('error' in rootResult) { res.status(rootResult.status).json({ error: rootResult.error }); return; }
  const root = rootResult.root;
  const relDir = (req.query.path as string) || '';
  const absDir = path.resolve(root, relDir);
  // Security: ensure resolved path is within the project
  if (!isPathInside(root, absDir)) {
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
  const rootResult = getFileExplorerRoot(req.params.id, req.query.worktreeId);
  if ('error' in rootResult) { res.status(rootResult.status).json({ error: rootResult.error }); return; }
  const root = rootResult.root;
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
  walk(root, '');
  res.json({ results, truncated: results.length >= MAX_RESULTS });
});

app.get('/api/projects/:id/file', (req, res) => {
  const rootResult = getFileExplorerRoot(req.params.id, req.query.worktreeId);
  if ('error' in rootResult) { res.status(rootResult.status).json({ error: rootResult.error }); return; }
  const root = rootResult.root;
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
  const absPath = path.resolve(root, filePath);
  if (!isPathInside(root, absPath)) {
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
  const rootResult = getFileExplorerRoot(req.params.id, req.query.worktreeId);
  if ('error' in rootResult) { res.status(rootResult.status).json({ error: rootResult.error }); return; }
  const root = rootResult.root;
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
  const absPath = path.resolve(root, filePath);
  if (!isPathInside(root, absPath)) {
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

app.post('/api/projects/:id/file-reveal', (req, res) => {
  const rootResult = getFileExplorerRoot(req.params.id, req.query.worktreeId);
  if ('error' in rootResult) { res.status(rootResult.status).json({ error: rootResult.error }); return; }
  const root = rootResult.root;
  const filePath = req.body?.path as string | undefined;
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
  const absPath = path.resolve(root, filePath);
  if (!isPathInside(root, absPath)) {
    res.status(403).json({ error: 'Access denied' }); return;
  }
  try {
    if (!fs.existsSync(absPath)) {
      res.status(404).json({ error: 'File not found' }); return;
    }
    revealPathInFileSystem(absPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open file location', message: String(err) });
  }
});

// PUT endpoint - Edit existing file
app.put('/api/projects/:id/file', (req, res) => {
  const rootResult = getFileExplorerRoot(req.params.id, req.query.worktreeId);
  if ('error' in rootResult) { res.status(rootResult.status).json({ error: rootResult.error }); return; }
  const root = rootResult.root;
  const { path: filePath, content } = req.body;
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' }); return;
  }
  const absPath = path.resolve(root, filePath);
  if (!isPathInside(root, absPath)) {
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
  const rootResult = getFileExplorerRoot(req.params.id, req.query.worktreeId);
  if ('error' in rootResult) { res.status(rootResult.status).json({ error: rootResult.error }); return; }
  const root = rootResult.root;
  const { path: filePath, content } = req.body;
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' }); return;
  }
  const absPath = path.resolve(root, filePath);
  if (!isPathInside(root, absPath)) {
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
    res.json({ marketplaces: libListMarketplaces() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/skill-catalog/browse', (req, res) => {
  const marketplace = req.query.marketplace as string;
  if (!marketplace) { res.status(400).json({ error: 'Missing marketplace' }); return; }
  try {
    res.json({ plugins: libBrowsePlugins(marketplace), marketplace });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/skill-catalog/installed', (req, res) => {
  try {
    res.json({ installed: libListInstalledPlugins() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/skill-catalog/install', (req, res) => {
  const { plugin, marketplace } = req.body;
  if (!plugin || !marketplace) { res.status(400).json({ error: 'Missing plugin or marketplace' }); return; }
  try {
    const output = libInstallPlugin(plugin, marketplace);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/skill-catalog/uninstall', (req, res) => {
  const { plugin, marketplace } = req.body;
  if (!plugin || !marketplace) { res.status(400).json({ error: 'Missing plugin or marketplace' }); return; }
  try {
    const output = libUninstallPlugin(plugin, marketplace);
    res.json({ ok: true, output });
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
app.use('/api/projects/:id/github', githubRoutes);

// --- Performance monitoring ---
app.get('/api/perf', requireAuth, (_req, res) => {
  res.json(getPerfSnapshot());
});

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
      const { isRuntimeHostedByDaemon } = await import('../shared/agent-bridge');
      res.json({
        connected: true,
        // False means agent sessions live in-process and will not survive a
        // server restart, which shows up to users as "cannot reconnect".
        agentRuntimeHostedByDaemon: isRuntimeHostedByDaemon(),
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
  const pidPath = path.join(os.homedir(), '.pilot-console', 'daemon.pid');
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
  const secretPath = path.join(os.homedir(), '.pilot-console', 'daemon.secret');
  const lockPath = path.join(os.homedir(), '.pilot-console', 'daemon.lock');
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

app.post('/api/agent/reconnect', requireAuth, async (_req, res) => {
  try {
    const { reconnectAgentRuntime } = await import('../shared/agent-bridge');
    await reconnectAgentRuntime();
    res.json({ ok: true });
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
    endCliSession(String(req.params.id), { skipDaemonKill: true });
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
const agentWss = setupAgentWebSocketServer();
const serverWss = setupServerWebSocketServer();
httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = parse(req.url!, true);
  if (pathname && pathname.startsWith('/api/lavish/')) {
    handleLavishUpgrade(req, socket, head);
  } else if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/agent') {
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/server') {
    serverWss.handleUpgrade(req, socket, head, (ws) => {
      serverWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Initialize the daemon bridge BEFORE listening so that surviving
// daemon-owned PTY sessions are reconciled into `activeSessions` before
// the HTTP/WS server starts accepting requests. Otherwise a browser
// reconnecting after a server restart can hit `/api/sessions/active`
// (returning []) or open a WS with a stale sessionId (rejected with 4003)
// before reconciliation completes — losing the resume opportunity.
//
// `initDaemonBridge()` already handles a missing/unreachable daemon
// gracefully (it logs and returns), so awaiting it here cannot block
// startup on daemon availability. We still wrap in try/catch so any
// unexpected error during reconciliation does not prevent the server
// from binding.
console.log('[server] Initializing daemon bridge before accepting requests...');
(async () => {
  try {
    await initDaemonBridge();
    console.log('[server] Daemon bridge initialized successfully');
  } catch (err) {
    console.error('Failed to initialize daemon bridge:', err);
  }

  httpServer.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    // Start the report scheduler and perf monitor once the server is live
    startScheduler();
    startLagMonitor();
    startDelegationMonitor();
  });
})();

// Detach from agent sessions on shutdown. When the runtime is hosted by the
// daemon the sessions keep running, so a restart (including a dev `--watch`
// reload) no longer kills in-flight turns.
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Received ${signal}, detaching agent bridge...`);
  try {
    await detachAgentBridge();
  } catch (err) {
    console.error('[server] Error during agent bridge detach:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

export { app, httpServer };
