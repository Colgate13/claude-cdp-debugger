import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandAllowed, CommandQueue } from '../src/lib/state.js';

test('commandAllowed: ping/status/stop allowed in any state', () => {
  for (const cmd of ['ping', 'status', 'stop'] as const) {
    for (const state of ['idle', 'running', 'paused', 'stepping'] as const) {
      assert.equal(commandAllowed(cmd, state).allowed, true, `${cmd} in ${state}`);
    }
  }
});

test('commandAllowed: locals/stack/step/resume require paused', () => {
  for (const cmd of ['locals', 'stack', 'step', 'resume'] as const) {
    assert.equal(commandAllowed(cmd, 'paused').allowed, true);
    assert.equal(commandAllowed(cmd, 'idle').allowed, false);
    assert.equal(commandAllowed(cmd, 'running').allowed, false);
  }
});

test('commandAllowed: bp.set requires running/paused/stepping (not idle)', () => {
  assert.equal(commandAllowed('bp.set', 'running').allowed, true);
  assert.equal(commandAllowed('bp.set', 'paused').allowed, true);
  assert.equal(commandAllowed('bp.set', 'stepping').allowed, true);
  assert.equal(commandAllowed('bp.set', 'idle').allowed, false);
});

test('commandAllowed: unknown command rejected', () => {
  const r = commandAllowed('frobnicate', 'idle');
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /Unknown command/);
});

test('CommandQueue: serializes async work', async () => {
  const q = new CommandQueue();
  const order: number[] = [];
  const tasks = [50, 10, 30].map((delay, i) =>
    q.run(async () => {
      await new Promise((r) => setTimeout(r, delay));
      order.push(i);
      return i;
    }),
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2]);
  assert.deepEqual(order, [0, 1, 2], 'tasks ran in submission order, not by delay');
});

test('CommandQueue: rejection propagates and queue continues', async () => {
  const q = new CommandQueue();
  const failPromise = q.run(async () => {
    throw new Error('boom');
  });
  await assert.rejects(failPromise, /boom/);
  const ok = await q.run(async () => 42);
  assert.equal(ok, 42);
});
