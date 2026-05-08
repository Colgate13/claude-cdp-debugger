import { appendFileSync, statSync, renameSync, openSync, closeSync } from 'node:fs';
import { logPath } from './ipc.mjs';

const ROTATION_BYTES = 10 * 1024 * 1024;

export class EventLog {
  constructor(slug) {
    this.path = logPath(slug);
    this.slug = slug;
    try {
      const fd = openSync(this.path, 'a');
      closeSync(fd);
    } catch { /* ignore */ }
  }

  append(event) {
    const enriched = { ts: Date.now(), ...event };
    const line = JSON.stringify(enriched) + '\n';
    try {
      appendFileSync(this.path, line);
    } catch (err) {
      try {
        appendFileSync(this.path + '.fallback', line);
      } catch { /* ignore */ }
      return;
    }
    this._maybeRotate();
  }

  _maybeRotate() {
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
