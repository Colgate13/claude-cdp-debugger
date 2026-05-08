import type { Protocol } from 'devtools-protocol';

/**
 * Runtime style of the target Node.js project as detected by `detect()`.
 * - `compiled`: TypeScript was built to `dist/` and source maps exist.
 * - `ts-node`: target runs `.ts` directly via ts-node/tsx/nest start.
 */
export type Runtime = 'compiled' | 'ts-node';

/**
 * Finite-state machine of a debug daemon. Most commands require a specific state
 * (see `commandAllowed` in {@link ./state.ts}).
 */
export type FsmState = 'idle' | 'running' | 'paused' | 'stepping';

/**
 * Resolved configuration for a project being debugged. Produced by
 * {@link ./detect.ts | detect} from `.vscode/launch.json` (and optionally
 * `.vscode/tasks.json`).
 */
export interface ProjectConfig {
  /** Absolute path to the project root (where .vscode/launch.json lives). */
  projectRoot: string;
  /** Filesystem-safe identifier derived from `projectRoot`. */
  slug: string;
  /** Inspector port (from `attach.port` or `attach.attachSimplePort`). */
  port: number;
  /** Inspector host. Always `127.0.0.1` for now. */
  host: string;
  /** Local source root used to translate paths to/from `remoteRoot`. */
  localRoot: string;
  /** Remote source root the inspector reports (e.g. `/app` for containerized targets). */
  remoteRoot: string;
  /** Docker container name extracted from `tasks.json`, if any. */
  container: string | null;
  /** Runtime style — affects whether breakpoint paths need source-map translation. */
  runtime: Runtime;
  /** Whether the target uses `--inspect-brk` (paused at startup until first `resume`). */
  inspectorBrk: boolean;
  /** `name` field of the chosen attach config, for diagnostics. */
  attachConfigName: string | null;
  /** `preLaunchTask` reference from launch.json, used to find the container task. */
  preLaunchTask: string | null;
}

/**
 * Subset of a VSCode `launch.json` configuration entry that this skill consumes.
 */
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

/**
 * Top-level shape of a `.vscode/launch.json` file (only fields we read).
 */
export interface LaunchJson {
  configurations?: AttachConfig[];
}

/**
 * Single task entry from a `.vscode/tasks.json`.
 */
export interface Task {
  label?: string;
  command?: string;
  args?: string[];
}

/**
 * Top-level shape of `.vscode/tasks.json` (only fields we read).
 */
export interface TasksJson {
  tasks?: Task[];
}

/**
 * Lossy summary of a CDP `CallFrame`, suitable for inclusion in event logs and
 * IPC responses without leaking internal CDP object IDs.
 */
export interface FrameSummary {
  function: string;
  scriptId: string | null;
  url: string | null;
  file: string | null;
  line: number;
  column: number;
  callFrameId: string;
}

/**
 * Discriminator for breakpoint behavior:
 * - `breakpoint` — pauses execution
 * - `logpoint` — captures an expression value and resumes (no pause)
 */
export type BreakpointKind = 'breakpoint' | 'logpoint';

/**
 * Round-trip information for a single source-map translation, attached to a
 * resolved {@link Breakpoint} so we can map back from JS frames to the
 * user-facing TypeScript path.
 */
export interface SourceMapInfo {
  jsPath: string;
  jsLine: number;
  jsColumn: number;
  tsPath: string;
  tsLine: number;
}

/**
 * Active or persisted breakpoint registration owned by the daemon.
 */
export interface Breakpoint {
  /** Daemon-local identifier (`bp-N`); stable for a single daemon lifetime. */
  id: string;
  /** Absolute local path the user named (TS or JS). */
  file: string;
  /** 1-indexed line number the user named. */
  line: number;
  /** Optional CDP `condition` expression. */
  cond: string | null;
  /** Optional logpoint expression — turns the BP into a log probe. */
  logExpr: string | null;
  kind: BreakpointKind;
  /** CDP-side breakpoint id returned by `Debugger.setBreakpointByUrl`. */
  cdpId: string;
  remoteUrl: string;
  remoteLine: number;
  /** How we translated the user's path to the remote URL. */
  sourcemap: SourceMapInfo | 'parallel-path' | null;
  locations: Protocol.Debugger.Location[];
}

/**
 * IPC request — discriminated union by `cmd`. Each variant carries exactly the
 * fields that command needs.
 */
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

/**
 * IPC response — every command returns `ok` plus arbitrary command-specific fields.
 * Specific shapes are not statically typed because output structure varies and is
 * primarily consumed by humans/agents, not other code.
 */
export type IpcResponse = { ok: boolean } & Record<string, unknown>;

/**
 * Single record appended to the event log. The discriminator (`event`) is open
 * because new event variants are introduced by handlers without a central
 * registry — see callers of {@link ./events.ts | EventLog.append}.
 */
export interface DebugEvent {
  event: string;
  [k: string]: unknown;
}

/**
 * Caps applied to LLM-friendly variable formatting in {@link ./format.ts}.
 * All fields are optional and fall back to reasonable defaults.
 */
export interface FormatOpts {
  depth?: number;
  maxProps?: number;
  maxArrayItems?: number;
  maxString?: number;
  totalCap?: number;
}

/**
 * Callback used by {@link ./format.ts | formatRemoteObject} to lazily expand a
 * CDP `RemoteObject` by `objectId`. Concrete implementations bind this to a
 * specific `Runtime.getProperties` request on a session.
 */
export type GetPropertiesFn = (
  objectId: string,
  opts?: { ownProperties?: boolean; generatePreview?: boolean; accessorPropertiesOnly?: boolean },
) => Promise<{ result?: Protocol.Runtime.PropertyDescriptor[]; internalProperties?: Protocol.Runtime.InternalPropertyDescriptor[] }>;
