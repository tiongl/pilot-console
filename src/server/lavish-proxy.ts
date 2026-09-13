import http from 'http';
import type { Request, Response } from 'express';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';
import { getUserFromToken, SESSION_COOKIE } from './middleware/auth';
import { getArtifactById } from '../shared/lavish-store';

/**
 * Same-origin reverse proxy for live Lavish artifact sessions.
 *
 * Why a proxy (not a raw localhost iframe):
 *  - The browser may not run on the daemon's machine, so it cannot reach
 *    `http://127.0.0.1:<port>` directly.
 *  - Lavish sends `X-Frame-Options: DENY` + `CSP: frame-ancestors 'none'` on the
 *    `/session/<key>` page, which blocks iframe embedding — the proxy strips
 *    those framing headers.
 *  - Lavish validates the Host header (a bogus Host → 403), so the proxy sets an
 *    accepted Host toward Lavish.
 *
 * Everything the SDK needs is served under the artifact's port, but the injected
 * chrome uses root-absolute URLs (`/chrome.css`, `/artifact/<key>/…`) and builds
 * its live-reload WebSocket URL from `location.host + "/events/<key>"`. So we
 * both rewrite the root-absolute asset refs in the outer HTML and inject a small
 * client shim (scoped to the proxied artifact document only) that blanket-
 * prefixes root-absolute fetch/XHR/WebSocket/EventSource requests.
 */

function proxyBase(artifactId: string): string {
  return `/api/lavish/${artifactId}`;
}

/** Extract the session cookie value from a raw Cookie header. */
function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const cookie = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(SESSION_COOKIE + '='))
    ?.split('=')
    .slice(1)
    .join('=');
  return cookie ? decodeURIComponent(cookie) : null;
}

/** Remove only the `frame-ancestors` directive from a CSP header value. */
function stripFrameAncestors(csp: string): string {
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors\b/i.test(d))
    .join('; ');
}

/**
 * The client shim runs INSIDE the proxied artifact document (a separate
 * browsing context from pilot-console), so it only patches that iframe — never
 * pilot-console's own app.
 */
function buildShim(base: string): string {
  const b = JSON.stringify(base);
  return `<script>(function(){
  var BASE=${b};
  function abs(u){return typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf(BASE+'/')!==0;}
  function fix(u){return abs(u)?BASE+u:u;}
  var of=window.fetch;
  if(of){window.fetch=function(input,init){
    try{
      if(typeof input==='string')return of(fix(input),init);
      if(input&&input.url&&abs(input.url))return of(new Request(BASE+input.url,input),init);
    }catch(e){}
    return of(input,init);
  };}
  var xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=fix(u);}catch(e){}return xo.apply(this,arguments);};
  var OW=window.WebSocket;
  if(OW){
    var PW=function(url,protocols){
      var u=url;
      try{
        if(typeof url==='string'){
          var m=url.match(/^(wss?:\\/\\/[^\\/]+)(\\/.*)$/);
          if(m&&m[2].indexOf(BASE+'/')!==0)u=m[1]+BASE+m[2];
        }
      }catch(e){}
      return protocols===undefined?new OW(u):new OW(u,protocols);
    };
    PW.prototype=OW.prototype;PW.CONNECTING=OW.CONNECTING;PW.OPEN=OW.OPEN;PW.CLOSING=OW.CLOSING;PW.CLOSED=OW.CLOSED;
    window.WebSocket=PW;
  }
  var OE=window.EventSource;
  if(OE){var PE=function(u,c){return new OE(fix(u),c);};PE.prototype=OE.prototype;PE.CONNECTING=OE.CONNECTING;PE.OPEN=OE.OPEN;PE.CLOSED=OE.CLOSED;window.EventSource=PE;}
})();</script>`;
}

/** Rewrite root-absolute src/href/action attrs and inject the client shim. */
export function rewriteHtml(html: string, base: string): string {
  let out = html.replace(
    /\b(src|href|action)=("|')(\/(?!\/)[^"']*)\2/gi,
    (_m, attr: string, q: string, path: string) => `${attr}=${q}${base}${path}${q}`,
  );

  const shim = buildShim(base);
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${shim}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html[^>]*>/i, (m) => `${m}${shim}`);
  } else {
    out = shim + out;
  }
  return out;
}

/**
 * Express middleware mounted at `/api/lavish/:artifactId`. Must be registered
 * BEFORE `express.json()` so the raw request body reaches Lavish untouched.
 */
export function lavishProxyMiddleware(req: Request, res: Response): void {
  const token = readSessionToken(req.headers.cookie);
  const user = token ? getUserFromToken(token) : null;
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const artifactId = String(req.params.artifactId);
  const artifact = getArtifactById(artifactId);
  if (!artifact) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }
  if (!artifact.port) {
    res.status(503).json({ error: 'Lavish session not ready yet' });
    return;
  }

  const base = proxyBase(artifactId);
  // `app.use('/api/lavish/:artifactId', …)` strips the mount path, so req.url is
  // the remainder (e.g. `/session/<key>`). Empty → root.
  const upstreamPath = req.url && req.url !== '' ? req.url : '/';

  const headers: Record<string, string | string[]> = { ...req.headers } as Record<string, string | string[]>;
  headers.host = `127.0.0.1:${artifact.port}`;
  // Force identity encoding so HTML can be rewritten reliably.
  delete headers['accept-encoding'];

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: artifact.port,
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (proxied: IncomingMessage) => {
      const outHeaders: Record<string, string | string[]> = { ...proxied.headers } as Record<string, string | string[]>;

      // Strip framing blockers so the iframe can load.
      delete outHeaders['x-frame-options'];
      const csp = outHeaders['content-security-policy'];
      if (typeof csp === 'string') {
        const sanitized = stripFrameAncestors(csp);
        if (sanitized) outHeaders['content-security-policy'] = sanitized;
        else delete outHeaders['content-security-policy'];
      }

      const contentType = String(proxied.headers['content-type'] ?? '');
      const isHtml = contentType.includes('text/html');

      if (!isHtml) {
        res.writeHead(proxied.statusCode ?? 502, outHeaders);
        proxied.pipe(res);
        return;
      }

      // Buffer HTML so we can rewrite root-absolute refs + inject the shim.
      const chunks: Buffer[] = [];
      proxied.on('data', (c: Buffer) => chunks.push(c));
      proxied.on('end', () => {
        const body = rewriteHtml(Buffer.concat(chunks).toString('utf8'), base);
        const buf = Buffer.from(body, 'utf8');
        delete outHeaders['content-length'];
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = String(buf.length);
        res.writeHead(proxied.statusCode ?? 200, outHeaders);
        res.end(buf);
      });
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Lavish upstream error: ${err.message}` });
    } else {
      res.end();
    }
  });

  // Forward the raw request body (registered before express.json()).
  req.pipe(upstream);
}

/**
 * Raw WebSocket-upgrade forwarder for `/api/lavish/:artifactId/*` (the SDK's
 * `/events/<key>` live channel). Wired into the httpServer 'upgrade' handler.
 */
export function handleLavishUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const token = readSessionToken(req.headers.cookie);
  const user = token ? getUserFromToken(token) : null;
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = req.url ?? '';
  const match = url.match(/^\/api\/lavish\/([^/]+)(\/.*)?$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const artifactId = match[1];
  const upstreamPath = match[2] ?? '/';

  const artifact = getArtifactById(artifactId);
  if (!artifact || !artifact.port) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
  headers.host = `127.0.0.1:${artifact.port}`;

  const upstreamReq = http.request({
    host: '127.0.0.1',
    port: artifact.port,
    method: req.method,
    path: upstreamPath,
    headers,
  });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`;
    const headerLines = Object.entries(upstreamRes.headers)
      .flatMap(([k, v]) => (Array.isArray(v) ? v.map((vv) => `${k}: ${vv}`) : v != null ? [`${k}: ${v}`] : []))
      .join('\r\n');
    socket.write(statusLine + headerLines + '\r\n\r\n');
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);

    const cleanup = () => {
      try { upstreamSocket.destroy(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    };
    upstreamSocket.on('error', cleanup);
    socket.on('error', cleanup);
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
  });

  upstreamReq.on('error', () => {
    try { socket.destroy(); } catch { /* ignore */ }
  });

  if (head && head.length) upstreamReq.write(head);
  upstreamReq.end();
}
