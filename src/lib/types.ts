import type { Protocol } from 'devtools-protocol';

export type Runtime = 'compiled' | 'ts-node';

export type FsmState = 'idle' | 'running' | 'paused' | 'stepping';

export interface ProjectConfig {
  projectRoot: string;
  slug: string;
  port: number;
  host: string;
  localRoot: string;
  remoteRoot: string;
  container: string | null;
  runtime: Runtime;
  inspectorBrk: boolean;
  attachConfigName: string | null;
  preLaunchTask: string | null;
}

export interface AttachConfig {
  name?: string;
  request?: string;
  type?: string;
  port?: number;
  attachSimplePort?: number;
  localRoot?: string;
  remoteRoot?: string;
  preLaunchTask?: string;
}

export interface LaunchJson {
  configurations?: AttachConfig[];
}

export interface Task {
  label?: string;
  command?: string;
  args?: string[];
}

export interface TasksJson {
  tasks?: Task[];
}

export interface FrameSummary {
  function: string;
  scriptId: string | null;
  url: string | null;
  file: string | null;
  line: number;
  column: number;
  callFrameId: string;
}

export type BreakpointKind = 'breakpoint' | 'logpoint';

export interface SourceMapInfo {
  jsPath: string;
  jsLine: number;
  jsColumn: number;
  tsPath: string;
  tsLine: number;
}

export interface Breakpoint {
  id: string;
  file: string;
  line: number;
  cond: string | null;
  logExpr: string | null;
  kind: BreakpointKind;
  cdpId: string;
  remoteUrl: string;
  remoteLine: number;
  sourcemap: SourceMapInfo | 'parallel-path' | null;
  locations: Protocol.Debugger.Location[];
}

// IPC requests — discriminated union by `cmd`
export type IpcRequest =
  | { cmd: 'ping' }
  | { cmd: 'status' }
  | { cmd: 'stop' }
  | { cmd: 'bp.set'; file: string; line: number; cond?: string | null; logExpr?: string | null }
  | { cmd: 'bp.list' }
  | { cmd: 'bp.rm'; id: string }
  | { cmd: 'wait'; timeout?: number }
  | { cmd: 'eval'; expr: string; depth?: number; frame?: number }
  | { cmd: 'locals'; depth?: number }
  | { cmd: 'stack' }
  | { cmd: 'step'; direction: 'over' | 'in' | 'out' }
  | { cmd: 'resume' };

export type IpcResponse = { ok: boolean } & Record<string, unknown>;

// EventLog entries — keep the discriminator open since fields vary widely.
export interface DebugEvent {
  event: string;
  [k: string]: unknown;
}

export interface FormatOpts {
  depth?: number;
  maxProps?: number;
  maxArrayItems?: number;
  maxString?: number;
  totalCap?: number;
}

export type GetPropertiesFn = (
  objectId: string,
  opts?: { ownProperties?: boolean; generatePreview?: boolean; accessorPropertiesOnly?: boolean },
) => Promise<{ result?: Protocol.Runtime.PropertyDescriptor[]; internalProperties?: Protocol.Runtime.InternalPropertyDescriptor[] }>;

export interface PausedWaitResult {
  paused: boolean;
  frame?: FrameSummary | null;
  timeout?: boolean;
  already?: boolean;
}
