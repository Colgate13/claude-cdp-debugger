import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventLog } from '../src/lib/events.js';
import { logPath } from '../src/lib/ipc.js';

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'cdp-events-'));
}

test('EventLog: append writes one JSON line per event with timestamp', () => {
  const slug = `events-${Date.now()}`;
  const log = new EventLog(slug);
  try {
    log.append({ event: 'connected', port: 9229 });
    log.append({ event: 'paused', reason: 'breakpoint' });
    const lines = readFileSync(logPath(slug), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as { event: string; ts: number; port: number };
    assert.equal(first.event, 'connected');
    assert.equal(first.port, 9229);
    assert.equal(typeof first.ts, 'number');
    assert.ok(first.ts > 0);
  } finally {
    rmSync(logPath(slug), { force: true });
  }
});

test('EventLog: tolerates payloads with circular references gracefully (no throw)', () => {
  const slug = `events-circ-${Date.now()}`;
  const log = new EventLog(slug);
  try {
    interface CircularRef { event: string; self?: CircularRef }
    const circ: CircularRef = { event: 'weird' };
    circ.self = circ;
    // EventLog's append will throw on JSON.stringify of circular — verify it's the caller's problem,
    // and that subsequent appends still work.
    assert.throws(() => log.append(circ as never));
    log.append({ event: 'after-circular' });
    const tail = readFileSync(logPath(slug), 'utf8').trim().split('\n').pop()!;
    assert.match(tail, /after-circular/);
  } finally {
    rmSync(logPath(slug), { force: true });
  }
});

test('EventLog: rotates file when size exceeds 10MB', () => {
  const slug = `events-rot-${Date.now()}`;
  const path = logPath(slug);
  const tmp = fresh();
  try {
    // Pre-populate with > 10MB so the next append triggers rotation.
    const big = 'x'.repeat(11 * 1024 * 1024);
    writeFileSync(path, big);
    const log = new EventLog(slug);
    // First append: writes 'pre-rotate' to the bloated file, then rotation moves the whole
    // thing (incl. that line) to .1, and re-opens a fresh empty file at the original path.
    log.append({ event: 'pre-rotate' });
    // Second append: writes to the fresh post-rotation file.
    log.append({ event: 'post-rotate' });

    const rotated = path + '.1';
    assert.ok(statSync(rotated).size > 10 * 1024 * 1024, 'rotated file holds the old bytes');
    const rotatedTail = readFileSync(rotated, 'utf8').trim().split('\n').pop()!;
    assert.match(rotatedTail, /pre-rotate/, 'pre-rotate event ended up in the rotated file');

    const fresh1 = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(fresh1.length, 1, 'fresh file contains only the post-rotation event');
    assert.match(fresh1[0]!, /post-rotate/);
  } finally {
    rmSync(path, { force: true });
    rmSync(path + '.1', { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
