#!/usr/bin/env node
import { writeFileSync, unlinkSync } from 'node:fs';
import type { Protocol } from 'devtools-protocol';
import { detect } from '../lib/detect.js';
import { IpcServer, socketPath, pidPath } from '../lib/ipc.js';
import { DaemonContext } from '../lib/daemon-context.js';
import { registerBpHandlers } from '../lib/handlers-bp.js';
import { registerInspectHandlers } from '../lib/handlers-inspect.js';
import type { IpcRequest, IpcResponse } from '../lib/types.js';

interface DaemonArgs {
  project: string;
  reattach?: boolean;
  idleTimeout?: number;
}

function parseArgs(argv: string[]): DaemonArgs {
  const args: DaemonArgs = { project: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i] ?? args.project;
    else if (a === '--reattach') args.reattach = true;
    else if (a === '--idle-timeout') args.idleTimeout = Number(argv[++i]);
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const IDLE_TIMEOUT_MS = (ARGS.idleTimeout ?? 1800) * 1000;

let ctx: DaemonContext;
try {
  const cfg = await detect(ARGS.project);
  ctx = new DaemonContext(cfg);
} catch (err) {
  console.error(`detect failed: ${(err as Error).message}`);
  process.exit(2);
}

const SLUG = ctx.slug;
const log = ctx.log;
const session = ctx.session;

session.onPaused = (evt: Protocol.Debugger.PausedEvent): void => {
  void handlePaused(evt);
};

async function handlePaused(evt: Protocol.Debugger.PausedEvent): Promise<void> {
  const top = evt.callFrames[0] ?? null;
  ctx.setPausedFrame(top, evt.callFrames);
  ctx.setState('paused');

  const bpId = evt.hitBreakpoints?.[0];
  const matched = bpId ? ctx.findBreakpointByCdpId(bpId) : null;

  // Logpoint: don't pause user, capture and resume
  if (matched?.kind === 'logpoint' && matched.logExpr && top) {
    try {
      const r = await session.evaluateOnCallFrame(top.callFrameId, `(${matched.logExpr})`, { returnByValue: true });
      log.append({
        event: 'logpoint',
        bp: matched.id,
        file: matched.file,
        line: matched.line,
        value: r.result.value,
        type: r.result.type,
        exception: r.exceptionDetails?.text ?? null,
      });
    } catch (err) {
      log.append({ event: 'logpoint-error', bp: matched.id, error: (err as Error).message });
    }
    ctx.setPausedFrame(null, null);
    ctx.setState('running');
    await session.resume().catch(() => undefined);
    return;
  }

  log.append({
    event: 'paused',
    reason: evt.reason,
    bp: matched?.id ?? null,
    frame: top ? ctx.summarizeFrame(top) : null,
    callFrames: evt.callFrames.slice(0, 10).map((f) => ctx.summarizeFrame(f)),
  });

  ctx.resolveWaiters({ paused: true, frame: top ? ctx.summarizeFrame(top) : null });
}

session.onResumed = (): void => {
  ctx.setPausedFrame(null, null);
  ctx.setState('running');
  log.append({ event: 'resumed' });
};

session.onDetached = (reason: string): void => {
  log.append({ event: 'detached', reason });
  ctx.setState('idle');
  void cleanup(1);
};

ctx.handlers.ping = (): Promise<IpcResponse> => Promise.resolve({ ok: true, pong: true });

ctx.handlers.status = (): Promise<IpcResponse> =>
  Promise.resolve({
    ok: true,
    slug: SLUG,
    pid: process.pid,
    project: ctx.cfg.projectRoot,
    runtime: ctx.cfg.runtime,
    container: ctx.cfg.container,
    port: ctx.cfg.port,
    state: ctx.getState(),
    target: session.target ? { id: session.target.id, title: session.target.title, url: session.target.url } : null,
    breakpoints: [...ctx.breakpoints.values()].map((b) => ({
      id: b.id,
      file: b.file,
      line: b.line,
      kind: b.kind,
      cond: b.cond,
      logExpr: b.logExpr,
    })),
    paused: !!ctx.getPausedFrame(),
    frame: ctx.getPausedFrame() ? ctx.summarizeFrame(ctx.getPausedFrame()!) : null,
    idleSeconds: ctx.idleSeconds(),
  });

ctx.handlers.stop = (): Promise<IpcResponse> => {
  log.append({ event: 'stopping' });
  setImmediate(() => {
    void cleanup(0);
  });
  return Promise.resolve({ ok: true });
};

registerBpHandlers(ctx);
registerInspectHandlers(ctx);

async function cleanup(code: number): Promise<void> {
  try { await session.close(); } catch { /* ignore */ }
  try { await ipc.stop(); } catch { /* ignore */ }
  try { unlinkSync(pidPath(SLUG)); } catch { /* ignore */ }
  process.exit(code);
}

const ipc = new IpcServer<IpcRequest, IpcResponse>(socketPath(SLUG), async (req) => {
  ctx.touch();
  const handler = ctx.handlers[req.cmd];
  if (!handler) return { ok: false, error: `Unknown command: ${req.cmd}` };
  try {
    return await handler(req);
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.message, stack: e.stack };
  }
});

await ipc.start();
writeFileSync(pidPath(SLUG), String(process.pid));
log.append({
  event: 'daemon-starting',
  slug: SLUG,
  project: ctx.cfg.projectRoot,
  port: ctx.cfg.port,
  container: ctx.cfg.container,
  runtime: ctx.cfg.runtime,
  pid: process.pid,
});

try {
  await session.connect(ctx.cfg.host, ctx.cfg.port, { timeoutMs: 5000 });
  ctx.setState('running');
  log.append({
    event: 'connected',
    port: ctx.cfg.port,
    target: session.target ? { id: session.target.id, title: session.target.title, url: session.target.url } : null,
  });
} catch (err) {
  log.append({
    event: 'connect-failed',
    error: (err as Error).message,
    port: ctx.cfg.port,
    container: ctx.cfg.container,
    recovery: ctx.cfg.container ? `docker start ${ctx.cfg.container}` : `start the Node process with --inspect=${ctx.cfg.port}`,
  });
  await cleanup(3);
}

setInterval(() => {
  if (ctx.idleSeconds() * 1000 > IDLE_TIMEOUT_MS && ctx.pendingWaiterCount() === 0 && ctx.getState() !== 'paused') {
    log.append({ event: 'idle-timeout', after: ctx.idleSeconds() });
    void cleanup(0);
  }
}, 60_000).unref();

if (ARGS.reattach) {
  const persisted = ctx.loadPersistedBreakpoints();
  const setHandler = ctx.handlers['bp.set'];
  if (!setHandler) {
    log.append({ event: 'reattach-skipped', reason: 'bp.set handler not available' });
  } else {
    for (const b of persisted) {
      try {
        const r = await setHandler({ file: b.file, line: b.line, cond: b.cond, logExpr: b.logExpr });
        if (r.ok) {
          log.append({
            event: 'breakpoint-reattached',
            original: b.id,
            new: r.id,
            file: b.file,
            line: b.line,
            locations: r.locationCount,
          });
        } else {
          log.append({
            event: 'breakpoint-reattach-failed',
            original: b.id,
            file: b.file,
            line: b.line,
            error: r.error,
          });
        }
      } catch (err) {
        log.append({ event: 'breakpoint-reattach-failed', original: b.id, error: (err as Error).message });
      }
    }
  }
}

process.on('SIGTERM', () => { void cleanup(0); });
process.on('SIGINT', () => { void cleanup(0); });
process.on('uncaughtException', (err) => {
  log.append({ event: 'uncaught-exception', error: err.message, stack: err.stack });
  void cleanup(4);
});
process.on('unhandledRejection', (reason) => {
  log.append({ event: 'unhandled-rejection', reason: String(reason) });
});
