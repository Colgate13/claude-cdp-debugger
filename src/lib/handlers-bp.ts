import { isAbsolute, resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { localToRemote } from './detect.js';
import { SourceMapResolver } from './sourcemap.js';
import type { DaemonContext } from './daemon-context.js';
import { escapeRegex } from './daemon-context.js';
import type { Breakpoint, FrameSummary, IpcResponse, SourceMapInfo } from './types.js';

interface TranslatedLocation {
  remotePath: string;
  remoteLine: number;
  sourcemap: SourceMapInfo | 'parallel-path' | null;
}

export function registerBpHandlers(ctx: DaemonContext): void {
  const cfg = ctx.cfg;
  const session = ctx.session;
  const breakpoints = ctx.breakpoints;
  const log = ctx.log;

  let smr: SourceMapResolver | null = null;
  function getSmr(): SourceMapResolver {
    smr ??= new SourceMapResolver({ projectRoot: cfg.projectRoot });
    return smr;
  }

  let bpCounter = 0;
  function nextBpId(): string {
    return `bp-${++bpCounter}`;
  }

  function resolveLocalPath(file: string): string {
    return isAbsolute(file) ? file : resolve(cfg.projectRoot, file);
  }

  async function translateLocation(absLocal: string, line: number): Promise<TranslatedLocation> {
    const ext = extname(absLocal).toLowerCase();
    const isTs = ['.ts', '.mts', '.cts', '.tsx'].includes(ext);

    if (cfg.runtime === 'ts-node' || !isTs) {
      return {
        remotePath: localToRemote(absLocal, cfg),
        remoteLine: line,
        sourcemap: null,
      };
    }

    const trans = await getSmr().tsToJs(absLocal, line);
    if (!trans) {
      const rel = absLocal.startsWith(cfg.projectRoot + '/') ? absLocal.slice(cfg.projectRoot.length + 1) : null;
      if (rel?.startsWith('src/')) {
        const fallbackRel = rel.replace(/^src\//, 'dist/src/').replace(/\.[mc]?ts$/, '.js');
        const fallbackLocal = `${cfg.projectRoot}/${fallbackRel}`;
        if (existsSync(fallbackLocal)) {
          log.append({
            event: 'sourcemap-fallback',
            file: absLocal,
            line,
            fallback: fallbackLocal,
            note: 'No .js.map found; using parallel dist path with same line — line may be approximate.',
          });
          return { remotePath: localToRemote(fallbackLocal, cfg), remoteLine: line, sourcemap: 'parallel-path' };
        }
      }
      throw new Error(
        `Cannot translate ${absLocal}:${line} to JS — no source map and no parallel dist file. Pass the .js path directly: dist/.../foo.js:N`,
      );
    }
    return {
      remotePath: localToRemote(trans.jsPath, cfg),
      remoteLine: trans.jsLine,
      sourcemap: { jsPath: trans.jsPath, jsLine: trans.jsLine, jsColumn: trans.jsColumn, tsPath: absLocal, tsLine: line },
    };
  }

  ctx.handlers['bp.set'] = async (req): Promise<IpcResponse> => {
    const file = req.file as string | undefined;
    const lineRaw = req.line;
    if (!file || !lineRaw) return { ok: false, error: 'bp.set requires {file, line}' };
    const absLocal = resolveLocalPath(file);
    if (!existsSync(absLocal)) return { ok: false, error: `File not found: ${absLocal}` };
    const line = Number(lineRaw);
    let translated: TranslatedLocation;
    try {
      translated = await translateLocation(absLocal, line);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const remoteUrl = `file://${translated.remotePath}`;
    const urlRegex = `^${escapeRegex(remoteUrl)}$`;
    const cond = (req.cond as string | null | undefined) ?? null;
    const logExpr = (req.logExpr as string | null | undefined) ?? null;
    let cdpResp;
    try {
      cdpResp = await session.setBreakpointByUrl({
        urlRegex,
        lineNumber: translated.remoteLine,
        condition: cond ?? undefined,
      });
    } catch (err) {
      return {
        ok: false,
        error: `setBreakpointByUrl failed: ${(err as Error).message}`,
        urlRegex,
        line: translated.remoteLine,
      };
    }

    const id = nextBpId();
    const entry: Breakpoint = {
      id,
      file: absLocal,
      line,
      cond,
      logExpr,
      kind: logExpr ? 'logpoint' : 'breakpoint',
      cdpId: cdpResp.breakpointId,
      remoteUrl,
      remoteLine: translated.remoteLine,
      sourcemap: translated.sourcemap,
      locations: cdpResp.locations,
    };
    breakpoints.set(id, entry);
    ctx.persistBreakpoints();
    log.append({
      event: 'breakpoint-set',
      id,
      file: absLocal,
      line,
      remoteUrl,
      remoteLine: translated.remoteLine,
      cdpId: cdpResp.breakpointId,
      locationCount: cdpResp.locations.length,
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
      locationCount: cdpResp.locations.length,
      note:
        cdpResp.locations.length === 0
          ? 'Breakpoint registered but no resolved location yet — script may not be loaded; will activate when it loads.'
          : null,
    };
  };

  ctx.handlers['bp.list'] = (): Promise<IpcResponse> =>
    Promise.resolve({
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
        locations: b.locations.length,
      })),
    });

  ctx.handlers['bp.rm'] = async (req): Promise<IpcResponse> => {
    const id = req.id as string | undefined;
    if (!id) return { ok: false, error: 'bp.rm requires id (or "all")' };
    if (id === 'all') {
      const removed: string[] = [];
      for (const [bid, b] of breakpoints) {
        try {
          await session.removeBreakpoint(b.cdpId);
          removed.push(bid);
        } catch {
          /* ignore */
        }
      }
      breakpoints.clear();
      ctx.persistBreakpoints();
      log.append({ event: 'breakpoints-cleared', count: removed.length });
      return { ok: true, removed };
    }
    const b = breakpoints.get(id);
    if (!b) return { ok: false, error: `Unknown breakpoint id: ${id}` };
    try {
      await session.removeBreakpoint(b.cdpId);
    } catch (err) {
      return { ok: false, error: `removeBreakpoint failed: ${(err as Error).message}` };
    }
    breakpoints.delete(id);
    ctx.persistBreakpoints();
    log.append({ event: 'breakpoint-removed', id });
    return { ok: true, removed: id };
  };

  ctx.handlers.wait = (req): Promise<IpcResponse> => {
    const timeoutMs = (Number(req.timeout) || 30) * 1000;
    const paused = ctx.getPausedFrame();
    if (paused) {
      return Promise.resolve({ ok: true, paused: true, frame: ctx.summarizeFrame(paused), already: true });
    }
    return new Promise((resolve) => {
      let resolved = false;
      const onPaused: PausedWaiterResolve = (data) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ ok: true, ...data });
      };
      ctx.registerWaiter({ resolve: onPaused });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        ctx.removeWaiter(onPaused);
        resolve({ ok: true, paused: false, timeout: true });
      }, timeoutMs);
    });
  };
}

type PausedWaiterResolve = (data: { paused: boolean; frame?: FrameSummary | null; timeout?: boolean; already?: boolean }) => void;
