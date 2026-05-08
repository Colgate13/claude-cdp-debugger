import { appendFileSync, statSync, renameSync, openSync, closeSync } from 'node:fs';
import { logPath } from './ipc.js';
import type { DebugEvent } from './types.js';

const ROTATION_BYTES = 10 * 1024 * 1024;

export class EventLog {
  readonly path: string;
  readonly slug: string;

  constructor(slug: string) {
    this.path = logPath(slug);
    this.slug = slug;
    try {
      const fd = openSync(this.path, 'a');
      closeSync(fd);
    } catch { /* ignore */ }
  }

  append(event: DebugEvent): void {
    const enriched = { ts: Date.now(), ...event };
    const line = JSON.stringify(enriched) + '\n';
    try {
      appendFileSync(this.path, line);
    } catch {
      try {
        appendFileSync(this.path + '.fallback', line);
      } catch { /* ignore */ }
      return;
    }
    this._maybeRotate();
  }

  private _maybeRotate(): void {
    try {
      const st = statSync(this.path);
      if (st.size > ROTATION_BYTES) {
        renameSync(this.path, this.path + '.1');
        const fd = openSync(this.path, 'a');
        closeSync(fd);
      }
    } catch { /* ignore */ }
  }
}
