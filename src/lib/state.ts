import type { FsmState, IpcRequest } from './types.js';

/**
 * String-literal union of every IPC command. Derived from {@link IpcRequest}
 * so adding a new command immediately enforces a state-rule entry below.
 */
export type CommandName = IpcRequest['cmd'];

const COMMAND_RULES: Record<CommandName, FsmState[] | 'any'> = {
  ping: 'any',
  status: 'any',
  stop: 'any',
  'bp.set': ['running', 'paused', 'stepping'],
  'bp.list': 'any',
  'bp.rm': ['running', 'paused', 'stepping'],
  wait: ['running', 'stepping'],
  eval: 'any',
  locals: ['paused'],
  stack: ['paused'],
  step: ['paused'],
  resume: ['paused'],
};

/**
 * Validates whether a given IPC `command` is permitted while the daemon is in
 * `state`. Returns `{allowed: true}` or `{allowed: false, reason}` so callers
 * can echo the explanation to the user.
 */
export function commandAllowed(command: string, state: FsmState): { allowed: boolean; reason?: string } {
  const rule = COMMAND_RULES[command as CommandName];
  if (rule === undefined) return { allowed: false, reason: `Unknown command: ${command}` };
  if (rule === 'any') return { allowed: true };
  if (rule.includes(state)) return { allowed: true };
  return { allowed: false, reason: `Command '${command}' requires state ${rule.join('|')}; current=${state}` };
}

interface QueueEntry<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/**
 * Serializes async work items so CDP-mutating operations don't interleave.
 * Each `run()` is processed in submission order; rejections of one task do
 * not affect others.
 */
export class CommandQueue {
  private queue: QueueEntry<unknown>[] = [];
  private busy = false;

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn: fn, resolve: resolve as (v: unknown) => void, reject });
      void this._drain();
    });
  }

  private async _drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        const r = await entry.fn();
        entry.resolve(r);
      } catch (err) {
        entry.reject(err);
      }
    }
    this.busy = false;
  }
}
