'use strict';
// Local diagnostic server. Bound to loopback only; Host-header check guards
// against DNS rebinding, and POSTs require an X-Statusline header (CSRF).
const http = require('http');
const fs = require('fs');
const path = require('path');
const log = require('../util/log');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function matchRoute(routes, method, pathname) {
  for (const [spec, handler] of Object.entries(routes)) {
    const [m, pattern] = spec.split(' ');
    if (m !== method) continue;
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      else if (patternParts[i] !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

// The single-page app owns these paths: a reload or a pasted link must serve
// the shell, which then routes client-side. Explicit list, not a catch-all, so
// a missing asset still 404s as itself.
const APP_PATHS = new Set(['/sessions', '/session', '/projects', '/experience', '/egress', '/settings']);

const isAppPath = (pathname) => APP_PATHS.has(pathname.split('/').slice(0, 2).join('/'));

function serveStatic(res, pathname) {
  const rel = pathname === '/' || isAppPath(pathname) ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(cfg, routes) {
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, '127.0.0.1', 'localhost']);

  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    if (!allowedHosts.has(host)) {
      res.writeHead(403).end('bad host');
      return;
    }
    const url = new URL(req.url, `http://${host}`);

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      serveStatic(res, url.pathname);
      return;
    }

    const csrf = req.headers['x-statusline'] === '1';
    if (req.method === 'POST' && !csrf) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'missing X-Statusline header' }));
      return;
    }

    const match = matchRoute(routes, req.method, url.pathname);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no such route' }));
      return;
    }

    let bodyRaw = '';
    req.on('data', (c) => {
      bodyRaw += c;
      if (bodyRaw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      let body = {};
      if (bodyRaw) {
        try {
          body = JSON.parse(bodyRaw);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON body' }));
          return;
        }
      }
      Promise.resolve()
        .then(() => match.handler(match.params, body))
        .then((result) => {
          const status = result && result._status ? result._status : 200;
          if (result && result._status) delete result._status;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((e) => {
          log.error(`api error ${req.method} ${url.pathname}: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(cfg.port, cfg.bind, () => resolve(server));
  });
}

module.exports = { createServer };
