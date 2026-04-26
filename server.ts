import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { setupWebSocketServer } from './lib/websocket-server';

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
