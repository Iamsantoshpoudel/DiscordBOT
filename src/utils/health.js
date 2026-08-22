'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/config');
const logger = require('./logger').child('health');
const { snapshot } = require('./metrics');

function tokensMatch(provided, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
/** @type {import('node:http').Server|null} */
let server = null;
/** @type {NodeJS.Timeout|null} */
let heartbeatTimer = null;
let acceptingCommands = true;
/** @type {() => object} */
let extraSnapshot = () => ({});

function setAcceptingCommands(value) {
  acceptingCommands = Boolean(value);
}

function isAcceptingCommands() {
  return acceptingCommands;
}

function setExtraSnapshot(fn) {
  extraSnapshot = fn;
}

function writeHeartbeat() {
  try {
    const file = config.ops.heartbeatPath;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      acceptingCommands,
      ...snapshot(extraSnapshot()),
    });
    fs.writeFileSync(file, `${body}\n`);
  } catch (err) {
    logger.warn('heartbeat_write_failed', { error: err.message });
  }
}

function startHeartbeat() {
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, config.ops.heartbeatIntervalMs);
  heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Lightweight HTTP health/metrics server. Bound only when PORT or HEALTH_PORT
 * is set so a Render Background Worker is not forced to listen.
 * @param {number} port
 */
function authorized(req) {
  const token = config.ops.healthToken;
  if (!token) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const alt = req.headers['x-health-token'];
  return tokensMatch(bearer, token) || tokensMatch(alt, token);
}

function startHealthServer(port) {
  if (server) return server;

  server = http.createServer((req, res) => {
    try {
      req.setTimeout(5000);
      const url = req.url?.split('?')[0] || '/';
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      const payload = {
        status: acceptingCommands ? 'ok' : 'draining',
        ...snapshot(extraSnapshot()),
      };

      // Liveness: process is up. Must NOT 503 while Discord is still logging
      // in — that causes orchestrators (Render Web Service, k8s) to kill a
      // healthy boot. Use /ready for Discord-session readiness.
      if (url === '/health' || url === '/' || url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: payload.status,
          ready: payload.ready === true,
          acceptingCommands,
        }));
        return;
      }

      if (url === '/ready') {
        const ready = payload.ready === true && acceptingCommands;
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready, acceptingCommands }));
        return;
      }

      if (url === '/metrics') {
        if (!authorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      logger.error('health_request_failed', err);
      try {
        res.writeHead(500).end();
      } catch {
        /* ignore */
      }
    }
  });

  server.on('error', (err) => {
    logger.error('health_server_error', err, { port });
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 4000;
  if (config.ops.nodeEnv === 'production' && !config.ops.healthToken) {
    logger.warn('health_metrics_unauthenticated', { hint: 'Set HEALTH_TOKEN to protect GET /metrics' });
  }

  const host = config.ops.healthBind;
  server.listen(port, host, () => {
    logger.info('health_server_listening', { port, host });
  });

  return server;
}

function stopHealthServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const closing = server;
    server = null;
    if (typeof closing.closeAllConnections === 'function') {
      closing.closeAllConnections();
    }
    closing.close(() => resolve());
  });
}

module.exports = {
  startHealthServer,
  stopHealthServer,
  startHeartbeat,
  stopHeartbeat,
  writeHeartbeat,
  setAcceptingCommands,
  isAcceptingCommands,
  setExtraSnapshot,
};
