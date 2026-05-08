import { isAbsolute, resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { localToRemote, remoteToLocal } from './detect.mjs';
import { SourceMapResolver } from './sourcemap.mjs';

const D = globalThis.__debugDaemon;
if (!D) throw new Error('handlers-bp.mjs loaded outside daemon context');

const cfg = D.cfg;
const session = D.session;
const breakpoints = D.breakpoints;
const log = D.log;

let smr = null;
function getSmr() {
  if (!smr) smr = new SourceMapResolver({ projectRoot: cfg.projectRoot });
  return smr;
}

let bpCounter = 0;
function nextBpId() { return `bp-${++bpCounter}`; }

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function resolveLocalPath(file) {
  const abs = isAbsolute(file) ? file : resolve(cfg.projectRoot, file);
  return abs;
}

async function translateLocation(absLocal, line) {
  const ext = extname(absLocal).toLowerCase();
  const isTs = ['.ts', '.mts', '.cts', '.tsx'].includes(ext);

  if (cfg.runtime === 'ts-node' || !isTs) {
    return {
      remotePath: localToRemote(absLocal, cfg),
      remoteLine: line,
      sourcemap: null,
    };
  }

  // compiled + ts source → translate via source map (preferred) or parallel-path fallback
  const trans = await getSmr().tsToJs(absLocal, line);
  if (!trans) {
    const rel = absLocal.startsWith(cfg.projectRoot + '/') ? absLocal.slice(cfg.projectRoot.length + 1) : null;
    if (rel && rel.startsWith('src/')) {
      const fallbackRel = rel.replace(/^src\//, 'dist/src/').replace(/\.[mc]?ts$/, '.js');
      const fallbackLocal = `${cfg.projectRoot}/${fallbackRel}`;
      if (existsSync(fallbackLocal)) {
        log.append({ event: 'sourcemap-fallback', file: absLocal, line, fallback: fallbackLocal, note: 'No .js.map found; using parallel dist path with same line — line may be approximate.' });
        return { remotePath: localToRemote(fallbackLocal, cfg), remoteLine: line, sourcemap: 'parallel-path' };
      }
    }
    throw new Error(`Cannot translate ${absLocal}:${line} to JS — no source map and no parallel dist file. Pass the .js path directly: dist/.../foo.js:N`);
  }
  return {
    remotePath: localToRemote(trans.jsPath, cfg),
    remoteLine: trans.jsLine,
    sourcemap: { jsPath: trans.jsPath, jsLine: trans.jsLine, jsColumn: trans.jsColumn, tsPath: absLocal, tsLine: line },
  };
}

D.handlers['bp.set'] = async (req) => {
  if (!req.file || !req.line) return { ok: false, error: 'bp.set requires {file, line}' };
  const absLocal = resolveLocalPath(req.file);
  if (!existsSync(absLocal)) return { ok: false, error: `File not found: ${absLocal}` };
  const line = Number(req.line);
  let translated;
  try {
    translated = await translateLocation(absLocal, line);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const remoteUrl = `file://${translated.remotePath}`;
  const urlRegex = `^${escapeRegex(remoteUrl)}$`;
  let cdpResp;
  try {
    cdpResp = await session.setBreakpointByUrl({
      urlRegex,
      lineNumber: translated.remoteLine,
      condition: req.cond ?? undefined,
    });
  } catch (err) {
    return { ok: false, error: `setBreakpointByUrl failed: ${err.message}`, urlRegex, line: translated.remoteLine };
  }

  const id = nextBpId();
  const entry = {
    id,
    file: absLocal,
    line,
    cond: req.cond ?? null,
    logExpr: req.logExpr ?? null,
    kind: req.logExpr ? 'logpoint' : 'breakpoint',
    cdpId: cdpResp.breakpointId,
    remoteUrl,
    remoteLine: translated.remoteLine,
    sourcemap: translated.sourcemap,
    locations: cdpResp.locations ?? [],
  };
  breakpoints.set(id, entry);
  D.persistBreakpoints();
  log.append({
    event: 'breakpoint-set',
    id,
    file: absLocal,
    line,
    remoteUrl,
    remoteLine: translated.remoteLine,
    cdpId: cdpResp.breakpointId,
    locationCount: cdpResp.locations?.length ?? 0,
    kind: entry.kind,
  });
  return {
    ok: true,
    id,
    file: absLocal,
    line,
    remoteUrl,
    remoteLine: translated.remoteLine,
    kind: entry.kind,
    locationCount: cdpResp.locations?.length ?? 0,
    note: cdpResp.locations?.length === 0 ? 'Breakpoint registered but no resolved location yet — script may not be loaded; will activate when it loads.' : null,
  };
};

D.handlers['bp.list'] = async () => {
  return {
    ok: true,
    breakpoints: [...breakpoints.values()].map((b) => ({
      id: b.id,
      file: b.file,
      line: b.line,
      kind: b.kind,
      cond: b.cond,
      logExpr: b.logExpr,
      remoteUrl: b.remoteUrl,
      remoteLine: b.remoteLine,
      cdpId: b.cdpId,
      locations: b.locations?.length ?? 0,
    })),
  };
};

D.handlers['bp.rm'] = async (req) => {
  if (!req.id) return { ok: false, error: 'bp.rm requires id (or "all")' };
  if (req.id === 'all') {
    const removed = [];
    for (const [id, b] of breakpoints) {
      try { await session.removeBreakpoint(b.cdpId); removed.push(id); } catch { /* ignore */ }
    }
    breakpoints.clear();
    D.persistBreakpoints();
    log.append({ event: 'breakpoints-cleared', count: removed.length });
    return { ok: true, removed };
  }
  const b = breakpoints.get(req.id);
  if (!b) return { ok: false, error: `Unknown breakpoint id: ${req.id}` };
  try { await session.removeBreakpoint(b.cdpId); } catch (err) { return { ok: false, error: `removeBreakpoint failed: ${err.message}` }; }
  breakpoints.delete(req.id);
  D.persistBreakpoints();
  log.append({ event: 'breakpoint-removed', id: req.id });
  return { ok: true, removed: req.id };
};

D.handlers.wait = async (req) => {
  const timeoutMs = (Number(req.timeout) || 30) * 1000;
  if (D.getPausedFrame()) {
    return { ok: true, paused: true, frame: D.summarizeFrame(D.getPausedFrame()), already: true };
  }
  return new Promise((resolve) => {
    let resolved = false;
    const onPaused = (data) => { if (resolved) return; resolved = true; clearTimeout(timer); resolve({ ok: true, ...data }); };
    D.registerWaiter(onPaused);
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      D.removeWaiter(onPaused);
      resolve({ ok: true, paused: false, timeout: true });
    }, timeoutMs);
  });
};
