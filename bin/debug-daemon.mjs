#!/usr/bin/env node
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detect, localToRemote, remoteToLocal } from '../lib/detect.mjs';
import { CdpSession } from '../lib/cdp.mjs';
import { IpcServer, socketPath, pidPath, bpsPath } from '../lib/ipc.mjs';
import { EventLog } from '../lib/events.mjs';

const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const args = { project: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--reattach') args.reattach = true;
    else if (a === '--idle-timeout') args.idleTimeout = Number(argv[++i]);
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const IDLE_TIMEOUT_MS = (ARGS.idleTimeout ?? 1800) * 1000;

let cfg;
try {
  cfg = await detect(ARGS.project);
} catch (err) {
  console.error(`detect failed: ${err.message}`);
  process.exit(2);
}

const SLUG = cfg.slug;
const log = new EventLog(SLUG);
const session = new CdpSession();
const breakpoints = new Map();
let fsmState = 'idle';
let lastActivity = Date.now();
let pausedFrame = null;
let pausedCallFrames = null;
let pendingWaiters = [];

function setState(next) {
  if (fsmState !== next) {
    fsmState = next;
    log.append({ event: 'state', state: next });
  }
}

function touch() { lastActivity = Date.now(); }

function persistBreakpoints() {
  const arr = [...breakpoints.values()].map((b) => ({
    id: b.id,
    file: b.file,
    line: b.line,
    cond: b.cond ?? null,
    logExpr: b.logExpr ?? null,
    kind: b.kind,
    cdpId: b.cdpId,
  }));
  try { writeFileSync(bpsPath(SLUG), JSON.stringify(arr, null, 2)); } catch { /* ignore */ }
}

function loadPersistedBreakpoints() {
  const path = bpsPath(SLUG);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

session.onScriptParsed = (script) => {
  /* P2: source-map-aware notifications go here */
};

session.onPaused = async (evt) => {
  pausedFrame = evt.callFrames?.[0] ?? null;
  pausedCallFrames = evt.callFrames ?? [];
  setState('paused');

  const top = pausedFrame;
  const bpId = evt.hitBreakpoints?.[0];
  const matched = bpId ? findByCdpId(bpId) : null;

  // Logpoint: don't pause user, capture and resume
  if (matched?.kind === 'logpoint' && matched.logExpr) {
    try {
      const r = await session.evaluateOnCallFrame(top.callFrameId, `(${matched.logExpr})`, { returnByValue: true });
      log.append({ event: 'logpoint', bp: matched.id, file: matched.file, line: matched.line, value: r.result?.value, type: r.result?.type, exception: r.exceptionDetails?.text ?? null });
    } catch (err) {
      log.append({ event: 'logpoint-error', bp: matched.id, error: err.message });
    }
    pausedFrame = null;
    pausedCallFrames = null;
    setState('running');
    await session.resume().catch(() => {});
    return;
  }

  log.append({
    event: 'paused',
    reason: evt.reason,
    bp: matched?.id ?? null,
    frame: top ? summarizeFrame(top) : null,
    callFrames: (evt.callFrames ?? []).slice(0, 10).map(summarizeFrame),
  });

  const waiters = pendingWaiters;
  pendingWaiters = [];
  for (const w of waiters) w.resolve({ paused: true, frame: top ? summarizeFrame(top) : null });
};

session.onResumed = () => {
  pausedFrame = null;
  pausedCallFrames = null;
  setState('running');
  log.append({ event: 'resumed' });
};

session.onDetached = (reason) => {
  log.append({ event: 'detached', reason });
  setState('idle');
  cleanup(1);
};

function summarizeFrame(frame) {
  const loc = frame.location;
  const script = session.scripts.get(loc?.scriptId);
  const url = script?.url ?? frame.url ?? null;
  const localPath = url ? remoteToLocal(url, cfg) : null;
  return {
    function: frame.functionName || '<anonymous>',
    scriptId: loc?.scriptId ?? null,
    url,
    file: localPath ?? url,
    line: (loc?.lineNumber ?? 0) + 1,
    column: (loc?.columnNumber ?? 0) + 1,
    callFrameId: frame.callFrameId,
  };
}

function findByCdpId(cdpId) {
  for (const b of breakpoints.values()) if (b.cdpId === cdpId) return b;
  return null;
}

const handlers = {
  ping: async () => ({ ok: true, pong: true }),

  status: async () => ({
    ok: true,
    slug: SLUG,
    pid: process.pid,
    project: cfg.projectRoot,
    runtime: cfg.runtime,
    container: cfg.container,
    port: cfg.port,
    state: fsmState,
    target: session.target ? { id: session.target.id, title: session.target.title, url: session.target.url } : null,
    breakpoints: [...breakpoints.values()].map((b) => ({ id: b.id, file: b.file, line: b.line, kind: b.kind, cond: b.cond, logExpr: b.logExpr })),
    paused: !!pausedFrame,
    frame: pausedFrame ? summarizeFrame(pausedFrame) : null,
    idleSeconds: Math.round((Date.now() - lastActivity) / 1000),
  }),

  stop: async () => {
    log.append({ event: 'stopping' });
    setImmediate(() => cleanup(0));
    return { ok: true };
  },
};

async function cleanup(code) {
  try { await session.close(); } catch { /* ignore */ }
  try { await ipc.stop(); } catch { /* ignore */ }
  try { unlinkSync(pidPath(SLUG)); } catch { /* ignore */ }
  process.exit(code);
}

const ipc = new IpcServer(socketPath(SLUG), async (req) => {
  touch();
  const handler = handlers[req.cmd];
  if (!handler) return { ok: false, error: `Unknown command: ${req.cmd}` };
  try {
    return await handler(req);
  } catch (err) {
    return { ok: false, error: err.message, stack: err.stack };
  }
});

await ipc.start();
writeFileSync(pidPath(SLUG), String(process.pid));
log.append({ event: 'daemon-starting', slug: SLUG, project: cfg.projectRoot, port: cfg.port, container: cfg.container, runtime: cfg.runtime, pid: process.pid });

try {
  await session.connect(cfg.host, cfg.port, { timeoutMs: 5000 });
  setState('running');
  log.append({ event: 'connected', port: cfg.port, target: { id: session.target.id, title: session.target.title, url: session.target.url } });
} catch (err) {
  log.append({ event: 'connect-failed', error: err.message, port: cfg.port, container: cfg.container, recovery: cfg.container ? `docker start ${cfg.container}` : `start the Node process with --inspect=${cfg.port}` });
  await cleanup(3);
}

// P5 hook: idle timeout
setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS && pendingWaiters.length === 0 && fsmState !== 'paused') {
    log.append({ event: 'idle-timeout', after: Math.round((Date.now() - lastActivity) / 1000) });
    cleanup(0);
  }
}, 60_000).unref();

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Expose internal state to handlers added in later phases via global registry pattern
globalThis.__debugDaemon = {
  cfg, session, breakpoints, log, handlers, persistBreakpoints, escapeRegex,
  getState: () => fsmState, setState, summarizeFrame,
  getPausedFrame: () => pausedFrame, getPausedCallFrames: () => pausedCallFrames,
  registerWaiter: (resolve) => pendingWaiters.push({ resolve }),
  removeWaiter: (resolve) => { pendingWaiters = pendingWaiters.filter((w) => w.resolve !== resolve); },
  touch,
};

// Load phase 2/3/4 handlers dynamically (they extend handlers object)
try {
  await import('../lib/handlers-bp.mjs');
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') log.append({ event: 'handler-load-error', module: 'bp', error: err.message });
}
try {
  await import('../lib/handlers-inspect.mjs');
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') log.append({ event: 'handler-load-error', module: 'inspect', error: err.message });
}

// Re-attach persisted breakpoints AFTER handlers loaded (so we can reuse bp.set logic)
if (ARGS.reattach) {
  const persisted = loadPersistedBreakpoints();
  const setHandler = handlers['bp.set'];
  if (!setHandler) {
    log.append({ event: 'reattach-skipped', reason: 'bp.set handler not available' });
  } else {
    for (const b of persisted) {
      try {
        const r = await setHandler({ file: b.file, line: b.line, cond: b.cond, logExpr: b.logExpr });
        if (r.ok) {
          log.append({ event: 'breakpoint-reattached', original: b.id, new: r.id, file: b.file, line: b.line, locations: r.locationCount });
        } else {
          log.append({ event: 'breakpoint-reattach-failed', original: b.id, file: b.file, line: b.line, error: r.error });
        }
      } catch (err) {
        log.append({ event: 'breakpoint-reattach-failed', original: b.id, error: err.message });
      }
    }
  }
}

process.on('SIGTERM', () => cleanup(0));
process.on('SIGINT', () => cleanup(0));
process.on('uncaughtException', (err) => {
  log.append({ event: 'uncaught-exception', error: err.message, stack: err.stack });
  cleanup(4);
});
process.on('unhandledRejection', (reason) => {
  log.append({ event: 'unhandled-rejection', reason: String(reason) });
});
