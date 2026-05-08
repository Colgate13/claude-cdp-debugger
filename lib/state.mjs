/**
 * FSM helpers for the debug daemon.
 * States: idle | running | paused | stepping
 *
 * Validates whether a given command is allowed in the current state, and
 * provides a queue to serialize CDP-mutating operations.
 */

const COMMAND_RULES = {
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

export function commandAllowed(command, state) {
  const rule = COMMAND_RULES[command];
  if (rule === undefined) return { allowed: false, reason: `Unknown command: ${command}` };
  if (rule === 'any') return { allowed: true };
  if (rule.includes(state)) return { allowed: true };
  return { allowed: false, reason: `Command '${command}' requires state ${rule.join('|')}; current=${state}` };
}

export class CommandQueue {
  constructor() {
    this.queue = [];
    this.busy = false;
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      try {
        const r = await fn();
        resolve(r);
      } catch (err) {
        reject(err);
      }
    }
    this.busy = false;
  }
}
