import { createServer, type IncomingMessage } from 'http';
import { parse } from 'url';
import next from 'next';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { setupWebSocketServer } from './lib/websocket-server';
import { getAllSessions, endSessionByProject, endCliSession } from './lib/cli-bridge';
import { getProjectById } from './lib/project-store';
import { getDb } from './lib/app-db';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST ?? 'localhost';
const port = parseInt(process.env.PORT ?? '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ---------------------------------------------------------------------------
// Copilot config helpers
// ---------------------------------------------------------------------------

const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const SETTINGS_PATH = path.join(COPILOT_DIR, 'settings.json');
const MCP_CONFIG_PATH = path.join(COPILOT_DIR, 'mcp-config.json');

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

interface InstalledPlugin {
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  cache_path: string;
  installed_at?: string;
}

interface PluginSkill {
  name: string;
  path: string;
}

function getPluginSkills(cachePath: string): PluginSkill[] {
  const skillsDir = path.join(cachePath, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        path: path.join(skillsDir, e.name),
      }));
  } catch {
    return [];
  }
}

function getCopilotConfig(projectId?: string) {
  const settings = readJsonFile(SETTINGS_PATH);
  const mcpConfig = readJsonFile(MCP_CONFIG_PATH);

  const installedPlugins = (settings.installedPlugins as InstalledPlugin[]) || [];
  const enabledPlugins = (settings.enabledPlugins as Record<string, boolean>) || {};

  const plugins = installedPlugins.map((p) => {
    const key = `${p.name}@${p.marketplace}`;
    const enabled = enabledPlugins[key] ?? p.enabled ?? false;
    return {
      name: p.name,
      marketplace: p.marketplace,
      version: p.version,
      enabled,
      skills: getPluginSkills(p.cache_path),
    };
  });

  const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) || {};

  // Repo-level skills
  let repoSkills: { agentsMd: boolean; customInstructions: string[] } = {
    agentsMd: false,
    customInstructions: [],
  };

  if (projectId) {
    const project = getProjectById(projectId);
    if (project) {
      const repoPath = project.repoPath;
      repoSkills.agentsMd = fs.existsSync(path.join(repoPath, 'AGENTS.md'));
      const copilotDir = path.join(repoPath, '.github', 'copilot');
      if (fs.existsSync(copilotDir)) {
        try {
          repoSkills.customInstructions = fs
            .readdirSync(copilotDir)
            .filter((f) => f.endsWith('.md'));
        } catch {
          // ignore
        }
      }
    }
  }

  return { plugins, mcpServers, repoSkills };
}

function readMcpConfig(): Record<string, unknown> {
  const config = readJsonFile(MCP_CONFIG_PATH);
  return (config.mcpServers as Record<string, unknown>) || {};
}

function writeMcpConfig(mcpServers: Record<string, unknown>) {
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
}

app.prepare().then(() => {
  const upgrade = app.getUpgradeHandler();
  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);

      // Handle session APIs directly (same process as WS/PTY)
      if (parsedUrl.pathname === '/api/sessions/active' && req.method === 'GET') {
        const active = getAllSessions()
          .filter((s) => s.alive && s.projectId)
          .map((s) => ({ projectId: s.projectId!, sessionId: s.sessionId }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: active }));
        return;
      }

      // Directory browsing API for folder picker
      if (parsedUrl.pathname === '/api/browse' && req.method === 'GET') {
        const dirParam = (parsedUrl.query.dir as string) || os.homedir();
        const dir = path.resolve(dirParam);
        try {
          const stat = fs.statSync(dir);
          if (!stat.isDirectory()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a directory' }));
            return;
          }
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          const isGitRepo = fs.existsSync(path.join(dir, '.git'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: dir, dirs, isGitRepo, parent: path.dirname(dir) }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot read directory' }));
        }
        return;
      }

      const killMatch = parsedUrl.pathname?.match(/^\/api\/projects\/([^/]+)\/session$/);
      if (killMatch && req.method === 'DELETE') {
        const projectId = decodeURIComponent(killMatch[1]);
        const sessionId = parsedUrl.query.sessionId as string | undefined;

        if (sessionId) {
          // Kill specific session
          endCliSession(sessionId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          // Kill any active session for this project (legacy behavior)
          const session = getAllSessions().find((s) => s.alive && s.projectId === projectId);
          if (session) {
            endSessionByProject(session.userId, projectId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No active session' }));
          }
        }
        return;
      }

      // --- Copilot Config API ---

      if (parsedUrl.pathname === '/api/copilot-config' && req.method === 'GET') {
        const projectId = parsedUrl.query.projectId as string | undefined;
        const config = getCopilotConfig(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }

      if (parsedUrl.pathname === '/api/copilot-config/mcp') {
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req));
          writeMcpConfig(body.mcpServers || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const servers = readMcpConfig();
          servers[body.name] = body.config;
          writeMcpConfig(servers);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'DELETE') {
          const name = parsedUrl.query.name as string;
          if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing name parameter' }));
            return;
          }
          const servers = readMcpConfig();
          delete servers[name];
          writeMcpConfig(servers);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      if (parsedUrl.pathname === '/api/copilot-config/agents-md' && req.method === 'GET') {
        const projectId = parsedUrl.query.projectId as string | undefined;
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing projectId' }));
          return;
        }
        const project = getProjectById(projectId);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }
        const agentsPath = path.join(project.repoPath, 'AGENTS.md');
        if (!fs.existsSync(agentsPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AGENTS.md not found' }));
          return;
        }
        const content = fs.readFileSync(agentsPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content }));
        return;
      }

      // --- Project Todos API ---
      const todosMatch = parsedUrl.pathname?.match(/^\/api\/projects\/([^/]+)\/todos$/);
      if (todosMatch) {
        const projectId = decodeURIComponent(todosMatch[1]);

        if (req.method === 'GET') {
          const db = getDb();
          const todos = db.prepare('SELECT id, project_id as projectId, parent_id as parentId, text, done, position, created_at as createdAt FROM project_todos WHERE project_id = ? ORDER BY position').all(projectId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ todos }));
          return;
        }

        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const db = getDb();
          const id = crypto.randomUUID();
          const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM project_todos WHERE project_id = ? AND parent_id IS ?').get(projectId, body.parentId || null) as { maxPos: number };
          db.prepare('INSERT INTO project_todos (id, project_id, parent_id, text, position) VALUES (?, ?, ?, ?, ?)').run(id, projectId, body.parentId || null, body.text || '', (maxPos?.maxPos ?? -1) + 1);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id }));
          return;
        }
      }

      const todoItemMatch = parsedUrl.pathname?.match(/^\/api\/projects\/([^/]+)\/todos\/([^/]+)$/);
      if (todoItemMatch) {
        const projectId = decodeURIComponent(todoItemMatch[1]);
        const todoId = decodeURIComponent(todoItemMatch[2]);

        if (req.method === 'PATCH') {
          const body = JSON.parse(await readBody(req));
          const db = getDb();
          const sets: string[] = [];
          const vals: unknown[] = [];
          if (body.text !== undefined) { sets.push('text = ?'); vals.push(body.text); }
          if (body.done !== undefined) { sets.push('done = ?'); vals.push(body.done ? 1 : 0); }
          if (body.parentId !== undefined) { sets.push('parent_id = ?'); vals.push(body.parentId); }
          if (body.position !== undefined) { sets.push('position = ?'); vals.push(body.position); }
          if (sets.length > 0) {
            vals.push(todoId, projectId);
            db.prepare(`UPDATE project_todos SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`).run(...vals);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'DELETE') {
          const db = getDb();
          db.prepare('DELETE FROM project_todos WHERE id = ? AND project_id = ?').run(todoId, projectId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      // --- Session History API ---
      const sessionsMatch = parsedUrl.pathname?.match(/^\/api\/projects\/([^/]+)\/sessions$/);
      if (sessionsMatch && req.method === 'GET') {
        const projectId = decodeURIComponent(sessionsMatch[1]);
        const db = getDb();
        const sessions = db.prepare(`
          SELECT id, user_id as userId, project_id as projectId, copilot_session_id as copilotSessionId,
                 started_at as startedAt, ended_at as endedAt,
                 CASE WHEN output_log IS NOT NULL THEN 1 ELSE 0 END as hasTranscript
          FROM cli_sessions
          WHERE project_id = ?
          ORDER BY started_at DESC
          LIMIT 50
        `).all(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions }));
        return;
      }

      const transcriptMatch = parsedUrl.pathname?.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
      if (transcriptMatch && req.method === 'GET') {
        const sessionId = decodeURIComponent(transcriptMatch[1]);
        const db = getDb();
        const row = db.prepare('SELECT output_log as outputLog FROM cli_sessions WHERE id = ?').get(sessionId) as { outputLog: string | null } | undefined;
        if (!row || !row.outputLog) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No transcript available' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transcript: row.outputLog }));
        return;
      }

      // ----- Git status endpoint -----
      const gitStatusMatch = parsedUrl.pathname?.match(/^\/api\/projects\/([^/]+)\/git-status$/);
      if (gitStatusMatch && req.method === 'GET') {
        const projectId = decodeURIComponent(gitStatusMatch[1]);
        const project = getProjectById(projectId);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }
        try {
          const opts = { cwd: project.repoPath, encoding: 'utf-8' as const, timeout: 5000 };
          const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
          const status = execSync('git status --porcelain', opts).trim();
          const diffStat = execSync('git diff --stat', opts).trim();
          const files = status ? status.split('\n').map(line => {
            const status = line.substring(0, 2).trim();
            const filePath = line.substring(3);
            return { status, path: filePath };
          }) : [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ branch, files, diffStat }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Git command failed', message: String(err) }));
        }
        return;
      }

      // ----- Git diff endpoint -----
      const gitDiffMatch = parsedUrl.pathname?.match(/^\/api\/projects\/([^/]+)\/git-diff$/);
      if (gitDiffMatch && req.method === 'GET') {
        const projectId = decodeURIComponent(gitDiffMatch[1]);
        const filePath = parsedUrl.query.file as string;
        const project = getProjectById(projectId);
        if (!project || !filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing project or file' }));
          return;
        }
        try {
          const opts = { cwd: project.repoPath, encoding: 'utf-8' as const, timeout: 5000 };
          let diff = '';
          try { diff = execSync(`git diff -- "${filePath}"`, opts).trim(); } catch {}
          if (!diff) {
            try { diff = execSync(`git diff --cached -- "${filePath}"`, opts).trim(); } catch {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ diff: diff || 'No changes' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // ----- Snippets CRUD endpoints -----
      const snippetsMatch = parsedUrl.pathname?.match(/^\/api\/projects\/([^/]+)\/snippets$/);
      if (snippetsMatch) {
        const projectId = decodeURIComponent(snippetsMatch[1]);

        if (req.method === 'GET') {
          const db = getDb();
          const snippets = db.prepare(
            'SELECT id, project_id as projectId, title, content, created_at as createdAt FROM project_snippets WHERE project_id = ? OR project_id IS NULL ORDER BY created_at DESC'
          ).all(projectId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ snippets }));
          return;
        }

        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const db = getDb();
          const id = crypto.randomUUID();
          db.prepare('INSERT INTO project_snippets (id, project_id, title, content) VALUES (?, ?, ?, ?)')
            .run(id, body.global ? null : projectId, body.title || 'Untitled', body.content || '');
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id }));
          return;
        }
      }

      const snippetDeleteMatch = parsedUrl.pathname?.match(/^\/api\/snippets\/([^/]+)$/);
      if (snippetDeleteMatch && req.method === 'DELETE') {
        const snippetId = decodeURIComponent(snippetDeleteMatch[1]);
        const db = getDb();
        db.prepare('DELETE FROM project_snippets WHERE id = ?').run(snippetId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (parsedUrl.pathname === '/api/projects' && req.method === 'GET') {
        const db = getDb();
        const projects = db.prepare('SELECT id, name, repo_path as repoPath, description, pinned, sort_order as sortOrder, created_at as createdAt FROM projects ORDER BY pinned DESC, sort_order, name').all();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects }));
        return;
      }

      // ----- Skill Catalog API -----

      if (parsedUrl.pathname === '/api/skill-catalog/marketplaces' && req.method === 'GET') {
        try {
          const raw = execSync('gh copilot plugin marketplace list', { encoding: 'utf-8', timeout: 15000 });
          const marketplaces: { name: string; source: string; builtin: boolean }[] = [];
          let builtinSection = false;
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (/included with/i.test(trimmed)) { builtinSection = true; continue; }
            if (/registered marketplace/i.test(trimmed)) { builtinSection = false; continue; }
            // Match lines like "  ✔ copilot-plugins (GitHub: github/copilot-plugins)" — any prefix char before the name
            const m = trimmed.match(/^\S+\s+([\w-]+)\s+\((?:GitHub:\s*)?([^)]+)\)/);
            if (!m) continue;
            marketplaces.push({ name: m[1], source: m[2], builtin: builtinSection });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ marketplaces }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (parsedUrl.pathname === '/api/skill-catalog/browse' && req.method === 'GET') {
        const marketplace = parsedUrl.query.marketplace as string;
        if (!marketplace) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing marketplace parameter' }));
          return;
        }
        try {
          const raw = execSync(`gh copilot plugin marketplace browse ${marketplace}`, { encoding: 'utf-8', timeout: 30000 });
          const plugins: { name: string; description: string }[] = [];
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            // Match "• plugin-name - Description text" — any prefix char
            const m = trimmed.match(/^\S+\s+([\w-]+)\s+-\s+(.+)/);
            if (m) {
              plugins.push({ name: m[1], description: m[2].trim() });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ plugins, marketplace }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (parsedUrl.pathname === '/api/skill-catalog/installed' && req.method === 'GET') {
        try {
          const raw = execSync('gh copilot plugin list', { encoding: 'utf-8', timeout: 15000 });
          const installed: { name: string; marketplace: string; version: string }[] = [];
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            // Match "• workiq@work-iq (v1.0.0)" — any prefix char
            const m = trimmed.match(/^\S+\s+([\w-]+)@([\w-]+)\s+\(v?([\d.]+)\)/);
            if (m) {
              installed.push({ name: m[1], marketplace: m[2], version: m[3] });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ installed }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (parsedUrl.pathname === '/api/skill-catalog/install' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const { plugin, marketplace } = body as { plugin: string; marketplace: string };
        if (!plugin || !marketplace) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing plugin or marketplace' }));
          return;
        }
        try {
          const output = execSync(`gh copilot plugin install ${plugin}@${marketplace}`, { encoding: 'utf-8', timeout: 60000 });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, output: output.trim() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (parsedUrl.pathname === '/api/skill-catalog/uninstall' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const { plugin, marketplace } = body as { plugin: string; marketplace: string };
        if (!plugin || !marketplace) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing plugin or marketplace' }));
          return;
        }
        try {
          const output = execSync(`gh copilot plugin uninstall ${plugin}@${marketplace}`, { encoding: 'utf-8', timeout: 30000 });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, output: output.trim() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (parsedUrl.pathname === '/api/skill-catalog/marketplace/add' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const { repo } = body as { repo: string };
        if (!repo) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing repo (e.g., owner/repo)' }));
          return;
        }
        try {
          const output = execSync(`gh copilot plugin marketplace register ${repo}`, { encoding: 'utf-8', timeout: 30000 });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, output: output.trim() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Request handler error', err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  const wss = setupWebSocketServer();

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url!, true);
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      // Let Next.js handle HMR and other upgrades
      upgrade(req, socket, head);
    }
  });

  httpServer.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
