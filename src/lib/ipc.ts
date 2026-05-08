import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** Returns the Unix socket path for a daemon identified by `slug`. */
export function socketPath(slug: string): string {
  return `/tmp/claude-debug-${slug}.sock`;
}

/** Returns the PID file path for a daemon identified by `slug`. */
export function pidPath(slug: string): string {
  return `/tmp/claude-debug-${slug}.pid`;
}

/** Returns the structured event log path for a daemon identified by `slug`. */
export function logPath(slug: string): string {
  return `/tmp/claude-debug-${slug}.log`;
}

/** Returns the persisted-breakpoints JSON path for a daemon identified by `slug`. */
export function bpsPath(slug: string): string {
  return `/tmp/claude-debug-${slug}.bps.json`;
}

/** Removes a socket file if it exists; ignores `ENOENT`. */
export async function tryRemoveSocket(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Probes whether a Unix socket has an accepting listener. Returns `false` if
 * the socket file is missing, the connect errors, or it doesn't accept within
 * 500ms.
 */
export async function isSocketAlive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return new Promise((resolve) => {
    const sock = connect(path);
    let done = false;
    const finish = (alive: boolean): void => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(alive);
    };
    sock.once('connect', () => { finish(true); });
    sock.once('error', () => { finish(false); });
    setTimeout(() => { finish(false); }, 500);
  });
}

/** Async function that maps an IPC request to a response. */
export type IpcHandler<Req, Res> = (req: Req) => Promise<Res>;

/**
 * NDJSON-over-Unix-socket server. Each accepted connection reads
 * newline-delimited JSON requests, hands each one to `handler`, and writes a
 * single JSON response per request followed by a newline.
 */
export class IpcServer<Req, Res> {
  private server: Server | null = null;
  private connections = new Set<Socket>();

  constructor(public readonly path: string, private readonly handler: IpcHandler<Req, Res>) {}

  async start(): Promise<void> {
    await tryRemoveSocket(this.path);
    this.server = createServer((socket) => {
      this.connections.add(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let req: Req;
          try {
            req = JSON.parse(line) as Req;
          } catch (err) {
            socket.write(JSON.stringify({ ok: false, error: `Invalid JSON: ${(err as Error).message}` }) + '\n');
            continue;
          }
          Promise.resolve()
            .then(() => this.handler(req))
            .then((res) => {
              socket.write(JSON.stringify(res ?? { ok: true }) + '\n');
            })
            .catch((err: unknown) => {
              const e = err as Error;
              socket.write(JSON.stringify({ ok: false, error: e.message ?? String(err), stack: e.stack }) + '\n');
            });
        }
      });
      socket.on('error', () => { this.connections.delete(socket); });
      socket.on('close', () => { this.connections.delete(socket); });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.path, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const sock of this.connections) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      this.server = null;
    }
    await tryRemoveSocket(this.path);
  }
}

/**
 * Stateless one-shot client: opens a Unix socket, sends a single JSON request,
 * reads one JSON response, closes. Throws on connection error or timeout.
 */
export async function ipcRequest<Res = unknown>(
  path: string,
  request: unknown,
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let buffer = '';
    let settled = false;
    const finish = (err: Error | null, value?: Res): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value as Res);
    };
    const timer = setTimeout(() => { finish(new Error(`IPC timeout after ${timeoutMs}ms`)); }, timeoutMs);
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
          finish(null, JSON.parse(line) as Res);
        } catch (err) {
          finish(new Error(`Invalid IPC response: ${(err as Error).message}`));
        }
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); finish(err); });
    sock.on('close', () => { clearTimeout(timer); if (!settled) finish(new Error('IPC connection closed without response')); });
  });
}
