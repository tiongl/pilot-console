import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setupWebSocketServer } from './lib/websocket-server';
import { getAllSessions, endSessionByProject } from './lib/cli-bridge';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST ?? 'localhost';
const port = parseInt(process.env.PORT ?? '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

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
        // Find any active session for this project (single-user app)
        const session = getAllSessions().find((s) => s.alive && s.projectId === projectId);
        if (session) {
          endSessionByProject(session.userId, projectId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No active session' }));
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
