import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import type { Protocol } from 'devtools-protocol';
import { CdpSession } from './cdp.js';
import { EventLog } from './events.js';
import { bpsPath } from './ipc.js';
import { remoteToLocal } from './detect.js';
import type { Breakpoint, FrameSummary, FsmState, ProjectConfig, IpcResponse } from './types.js';

export type IpcHandlerFn = (req: Record<string, unknown>) => Promise<IpcResponse>;

export interface PausedWaiter {
  resolve: (data: { paused: boolean; frame?: FrameSummary | null; timeout?: boolean; already?: boolean }) => void;
}

export class DaemonContext {
  readonly cfg: ProjectConfig;
  readonly slug: string;
  readonly session: CdpSession;
  readonly breakpoints = new Map<string, Breakpoint>();
  readonly log: EventLog;
  readonly handlers: Record<string, IpcHandlerFn> = {};

  private fsmState: FsmState = 'idle';
  private lastActivity = Date.now();
  private pausedFrame: Protocol.Debugger.CallFrame | null = null;
  private pausedCallFrames: Protocol.Debugger.CallFrame[] | null = null;
  private pendingWaiters: PausedWaiter[] = [];

  constructor(cfg: ProjectConfig) {
    this.cfg = cfg;
    this.slug = cfg.slug;
    this.session = new CdpSession();
    this.log = new EventLog(cfg.slug);
  }

  setState(next: FsmState): void {
    if (this.fsmState !== next) {
      this.fsmState = next;
      this.log.append({ event: 'state', state: next });
    }
  }

  getState(): FsmState {
    return this.fsmState;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  idleSeconds(): number {
    return Math.round((Date.now() - this.lastActivity) / 1000);
  }

  pendingWaiterCount(): number {
    return this.pendingWaiters.length;
  }

  setPausedFrame(frame: Protocol.Debugger.CallFrame | null, callFrames: Protocol.Debugger.CallFrame[] | null): void {
    this.pausedFrame = frame;
    this.pausedCallFrames = callFrames;
  }

  getPausedFrame(): Protocol.Debugger.CallFrame | null {
    return this.pausedFrame;
  }

  getPausedCallFrames(): Protocol.Debugger.CallFrame[] | null {
    return this.pausedCallFrames;
  }

  registerWaiter(waiter: PausedWaiter): void {
    this.pendingWaiters.push(waiter);
  }

  removeWaiter(resolve: PausedWaiter['resolve']): void {
    this.pendingWaiters = this.pendingWaiters.filter((w) => w.resolve !== resolve);
  }

  resolveWaiters(data: { paused: boolean; frame?: FrameSummary | null }): void {
    const waiters = this.pendingWaiters;
    this.pendingWaiters = [];
    for (const w of waiters) w.resolve(data);
  }

  summarizeFrame(frame: Protocol.Debugger.CallFrame): FrameSummary {
    const loc = frame.location;
    const script = this.session.scripts.get(loc.scriptId);
    const url = script?.url ?? frame.url ?? null;
    const localPath = url ? remoteToLocal(url, this.cfg) : null;
    return {
      function: frame.functionName || '<anonymous>',
      scriptId: loc.scriptId ?? null,
      url,
      file: localPath ?? url,
      line: (loc.lineNumber ?? 0) + 1,
      column: (loc.columnNumber ?? 0) + 1,
      callFrameId: frame.callFrameId,
    };
  }

  findBreakpointByCdpId(cdpId: string): Breakpoint | null {
    for (const b of this.breakpoints.values()) if (b.cdpId === cdpId) return b;
    return null;
  }

  persistBreakpoints(): void {
    const arr = [...this.breakpoints.values()].map((b) => ({
      id: b.id,
      file: b.file,
      line: b.line,
      cond: b.cond,
      logExpr: b.logExpr,
      kind: b.kind,
      cdpId: b.cdpId,
    }));
    try {
      writeFileSync(bpsPath(this.slug), JSON.stringify(arr, null, 2));
    } catch {
      /* ignore */
    }
  }

  loadPersistedBreakpoints(): Pick<Breakpoint, 'id' | 'file' | 'line' | 'cond' | 'logExpr' | 'kind' | 'cdpId'>[] {
    const path = bpsPath(this.slug);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Breakpoint[];
    } catch {
      return [];
    }
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
