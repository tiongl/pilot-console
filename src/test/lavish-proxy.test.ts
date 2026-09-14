// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

/**
 * Integration test for the Lavish reverse proxy: a fake upstream stands in for
 * the Lavish daemon so we can assert the proxy strips frame-blocking headers,
 * rewrites root-absolute asset refs, and injects the client shim.
 */
describe('lavish proxy', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let app: express.Express;
  let appServer: http.Server;
  let appPort: number;

  beforeEach(async () => {
    vi.resetModules();

    // Fake Lavish upstream.
    upstream = http.createServer((req, res) => {
      if (req.url === '/session/key1') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'",
        });
        res.end(
          '<!doctype html><html><head><title>A</title></head><body>' +
            '<link href="/chrome.css"><script src="/chrome-client.js"></script>' +
            '<iframe src="/artifact/key1/index.html"></iframe>' +
            '<a href="https://ht-ml.app">ext</a></body></html>',
        );
        return;
      }
      if (req.url === '/chrome.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('body{color:red}');
        return;
      }
      res.writeHead(404).end('nope');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as AddressInfo).port;

    vi.doMock('../server/middleware/auth', () => ({
      SESSION_COOKIE: 'pilot_console_session',
      getUserFromToken: (token: string) => (token === 'good' ? { id: 'u1' } : null),
    }));
    vi.doMock('../shared/lavish-store', () => ({
      getArtifactById: (id: string) =>
        id === 'abc' ? { id: 'abc', port: upstreamPort, status: 'ready' } : null,
    }));

    const { lavishProxyMiddleware } = await import('../server/lavish-proxy');
    app = express();
    app.use('/api/lavish/:artifactId', lavishProxyMiddleware);
    appServer = http.createServer(app);
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
    appPort = (appServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => appServer.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
    vi.restoreAllMocks();
  });

  function get(path: string, cookie = 'pilot_console_session=good') {
    return fetch(`http://127.0.0.1:${appPort}${path}`, { headers: { cookie } });
  }

  it('rejects unauthenticated requests', async () => {
    const res = await get('/api/lavish/abc/session/key1', 'pilot_console_session=bad');
    expect(res.status).toBe(401);
  });

  it('404s an unknown artifact', async () => {
    const res = await get('/api/lavish/missing/session/key1');
    expect(res.status).toBe(404);
  });

  it('strips frame-blocking headers on the HTML response', async () => {
    const res = await get('/api/lavish/abc/session/key1');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('rewrites root-absolute asset refs and injects the shim', async () => {
    const res = await get('/api/lavish/abc/session/key1');
    const body = await res.text();
    expect(body).toContain('href="/api/lavish/abc/chrome.css"');
    expect(body).toContain('src="/api/lavish/abc/chrome-client.js"');
    expect(body).toContain('src="/api/lavish/abc/artifact/key1/index.html"');
    // External and non-root refs are left alone.
    expect(body).toContain('href="https://ht-ml.app"');
    // The client shim is injected and patches the live-reload WebSocket.
    expect(body).toContain('window.WebSocket');
    expect(body).toContain('/api/lavish/abc');
  });

  it('passes non-HTML assets through untouched', async () => {
    const res = await get('/api/lavish/abc/chrome.css');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body{color:red}');
  });
});
