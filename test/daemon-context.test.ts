import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonContext, escapeRegex } from '../src/lib/daemon-context.js';
import { bpsPath, logPath } from '../src/lib/ipc.js';
import type { ProjectConfig, Breakpoint } from '../src/lib/types.js';

function makeCfg(slug: string): ProjectConfig {
  return {
    projectRoot: '/tmp/_test',
    slug,
    port: 9229,
    host: '127.0.0.1',
    localRoot: '/tmp/_test',
    remoteRoot: '/app',
    container: null,
    runtime: 'compiled',
    inspectorBrk: false,
    attachConfigName: 'attach',
    preLaunchTask: null,
  };
}

test('DaemonContext: setState dedupes consecutive same-state writes', () => {
  const slug = `dctx-${Date.now()}-a`;
  const ctx = new DaemonContext(makeCfg(slug));
  try {
    ctx.setState('running');
    ctx.setState('running'); // no-op
    ctx.setState('paused');
    const lines = readFileSync(logPath(slug), 'utf8').trim().split('\n').filter(Boolean);
    const stateEvents = lines.map((l) => JSON.parse(l) as { event: string; state?: string })
      .filter((e) => e.event === 'state');
    assert.equal(stateEvents.length, 2);
    assert.equal(stateEvents[0]!.state, 'running');
    assert.equal(stateEvents[1]!.state, 'paused');
  } finally {
    rmSync(logPath(slug), { force: true });
  }
});

test('DaemonContext: idleSeconds increases over time, touch resets', async () => {
  const ctx = new DaemonContext(makeCfg(`dctx-${Date.now()}-b`));
  try {
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(ctx.idleSeconds() >= 1, `expected ≥1s, got ${ctx.idleSeconds()}`);
    ctx.touch();
    assert.ok(ctx.idleSeconds() < 1);
  } finally {
    rmSync(logPath(ctx.slug), { force: true });
  }
});

test('DaemonContext: persistBreakpoints writes JSON array to bps.json', () => {
  const slug = `dctx-${Date.now()}-c`;
  const ctx = new DaemonContext(makeCfg(slug));
  const bp: Breakpoint = {
    id: 'bp-1', file: '/x/y.ts', line: 10, cond: null, logExpr: null,
    kind: 'breakpoint', cdpId: 'cdp-1', remoteUrl: 'file:///app/y.js',
    remoteLine: 9, sourcemap: null, locations: [],
  };
  ctx.breakpoints.set('bp-1', bp);
  try {
    ctx.persistBreakpoints();
    const stored = JSON.parse(readFileSync(bpsPath(slug), 'utf8')) as Pick<Breakpoint, 'id' | 'file' | 'cdpId'>[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.id, 'bp-1');
    assert.equal(stored[0]!.cdpId, 'cdp-1');
  } finally {
    rmSync(bpsPath(slug), { force: true });
    rmSync(logPath(slug), { force: true });
  }
});

test('DaemonContext: loadPersistedBreakpoints round-trips with persistBreakpoints', () => {
  const slug = `dctx-${Date.now()}-d`;
  const ctx = new DaemonContext(makeCfg(slug));
  ctx.breakpoints.set('bp-x', {
    id: 'bp-x', file: '/foo.ts', line: 1, cond: 'x>0', logExpr: null,
    kind: 'breakpoint', cdpId: 'cdp-x', remoteUrl: '', remoteLine: 0, sourcemap: null, locations: [],
  });
  try {
    ctx.persistBreakpoints();
    const reloaded = ctx.loadPersistedBreakpoints();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]!.cond, 'x>0');
  } finally {
    rmSync(bpsPath(slug), { force: true });
    rmSync(logPath(slug), { force: true });
  }
});

test('DaemonContext: registerWaiter / resolveWaiters delivers paused payload', () => {
  const ctx = new DaemonContext(makeCfg(`dctx-${Date.now()}-e`));
  try {
    let received: { paused: boolean } | undefined;
    ctx.registerWaiter({ resolve: (data) => { received = data; } });
    assert.equal(ctx.pendingWaiterCount(), 1);
    ctx.resolveWaiters({ paused: true, frame: null });
    assert.equal(ctx.pendingWaiterCount(), 0);
    assert.deepEqual(received, { paused: true, frame: null });
  } finally {
    rmSync(logPath(ctx.slug), { force: true });
  }
});

test('DaemonContext: removeWaiter cancels a pending waiter', () => {
  const ctx = new DaemonContext(makeCfg(`dctx-${Date.now()}-f`));
  try {
    const fn = (): void => undefined;
    ctx.registerWaiter({ resolve: fn });
    assert.equal(ctx.pendingWaiterCount(), 1);
    ctx.removeWaiter(fn);
    assert.equal(ctx.pendingWaiterCount(), 0);
  } finally {
    rmSync(logPath(ctx.slug), { force: true });
  }
});

test('escapeRegex: escapes regex metacharacters', () => {
  assert.equal(escapeRegex('foo.bar'), 'foo\\.bar');
  assert.equal(escapeRegex('a+b*c?'), 'a\\+b\\*c\\?');
  // Forward slash is NOT a regex metachar in `new RegExp(str)` form, so it stays unescaped.
  assert.equal(escapeRegex('file:///a/b.js'), 'file:///a/b\\.js');
  assert.equal(escapeRegex('a(b|c)[d]'), 'a\\(b\\|c\\)\\[d\\]');
});

test('DaemonContext: tmpdir + slugify path resolution', () => {
  // Smoke: ensure log/bps paths are predictable and writable.
  const tmp = mkdtempSync(join(tmpdir(), 'dctx-'));
  const slug = `dctx-${Date.now()}-g`;
  const ctx = new DaemonContext(makeCfg(slug));
  try {
    ctx.setState('running');
    assert.match(logPath(slug), new RegExp(`claude-debug-${slug}\\.log$`));
    assert.match(bpsPath(slug), new RegExp(`claude-debug-${slug}\\.bps\\.json$`));
  } finally {
    rmSync(logPath(slug), { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
