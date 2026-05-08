import { createServer, connect } from 'node:net';
import { unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export function socketPath(slug) {
  return `/tmp/claude-debug-${slug}.sock`;
}

export function pidPath(slug) {
  return `/tmp/claude-debug-${slug}.pid`;
}

export function logPath(slug) {
  return `/tmp/claude-debug-${slug}.log`;
}

export function bpsPath(slug) {
  return `/tmp/claude-debug-${slug}.bps.json`;
}

export async function tryRemoveSocket(path) {
  try {
    await unlink(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function isSocketAlive(path) {
  if (!existsSync(path)) return false;
  return new Promise((resolve) => {
    const sock = connect(path);
    let done = false;
    const finish = (alive) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(alive);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), 500);
  });
}

export class IpcServer {
  constructor(path, handler) {
    this.path = path;
    this.handler = handler;
    this.server = null;
    this.connections = new Set();
  }

  async start() {
    await tryRemoveSocket(this.path);
    this.server = createServer((socket) => {
      this.connections.add(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let req;
          try {
            req = JSON.parse(line);
          } catch (err) {
            socket.write(JSON.stringify({ ok: false, error: `Invalid JSON: ${err.message}` }) + '\n');
            continue;
          }
          Promise.resolve()
            .then(() => this.handler(req))
            .then((res) => {
              socket.write(JSON.stringify(res ?? { ok: true }) + '\n');
            })
            .catch((err) => {
              socket.write(JSON.stringify({ ok: false, error: err.message ?? String(err), stack: err.stack }) + '\n');
            });
        }
      });
      socket.on('error', () => { this.connections.delete(socket); });
      socket.on('close', () => { this.connections.delete(socket); });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.path, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop() {
    for (const sock of this.connections) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    await tryRemoveSocket(this.path);
  }
}

export async function ipcRequest(path, request, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let buffer = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`IPC timeout after ${timeoutMs}ms`)), timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        clearTimeout(timer);
        try {
          finish(null, JSON.parse(line));
        } catch (err) {
          finish(new Error(`Invalid IPC response: ${err.message}`));
        }
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); finish(err); });
    sock.on('close', () => { clearTimeout(timer); if (!settled) finish(new Error('IPC connection closed without response')); });
  });
}
