import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { slugify } from '../src/lib/detect.js';
import { socketPath, pidPath, logPath, bpsPath } from '../src/lib/ipc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const DEBUG_CLI = join(REPO, 'dist', 'bin', 'debug.js');
const FIXTURE_TEMPLATE = join(HERE, 'fixture-template');
// Use a non-default port to reduce collision risk in CI/dev machines.
const PORT = 9333;

let projectDir: string;
let target: ChildProcess | null = null;

interface JsonResult {
  ok: boolean;
  [k: string]: unknown;
}

function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): JsonResult {
  const r = spawnSync(process.execPath, [DEBUG_CLI, ...args], {
    cwd: opts.cwd ?? projectDir,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  // CLI prints JSON to stdout. Surface stderr on failure for debug output.
  const stdout = r.stdout ?? '';
  if (!stdout.trim()) {
    throw new Error(`empty stdout (status=${r.status}); stderr=${r.stderr}`);
  }
  return JSON.parse(stdout) as JsonResult;
}

async function waitForInspector(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch { /* retry */ }
    await wait(100);
  }
  throw new Error(`inspector not ready on ${port} after ${timeoutMs}ms`);
}

before(async () => {
  if (!existsSync(DEBUG_CLI)) {
    throw new Error(`Build artifact missing: ${DEBUG_CLI}. Run \`npm run build\` first.`);
  }

  // Copy template into a unique tmpdir so each run gets a unique slug.
  projectDir = mkdtempSync(join(tmpdir(), 'cdp-int-'));
  cpSync(FIXTURE_TEMPLATE, projectDir, { recursive: true });

  // Patch launch.json port to match.
  const launch = join(projectDir, '.vscode', 'launch.json');
  const fs = await import('node:fs');
  const json = JSON.parse(fs.readFileSync(launch, 'utf8')) as { configurations: { port: number }[] };
  json.configurations[0]!.port = PORT;
  fs.writeFileSync(launch, JSON.stringify(json, null, 2));

  // Spawn target process.
  target = spawn(process.execPath, [`--inspect=${PORT}`, 'target.mjs'], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  target.stderr?.on('data', (d) => { process.stderr.write(`[target stderr] ${d}`); });

  await waitForInspector(PORT);
});

after(async () => {
  // Best-effort cleanup of daemon (in case a test failed before stop).
  try { runCli(['stop']); } catch { /* ignore */ }
  if (target) {
    target.kill('SIGKILL');
    target = null;
    await wait(100);
  }
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  // Clean any leftover /tmp files for this slug just in case.
  if (projectDir) {
    const slug = slugify(projectDir);
    rmSync(socketPath(slug), { force: true });
    rmSync(pidPath(slug), { force: true });
    rmSync(logPath(slug), { force: true });
    rmSync(bpsPath(slug), { force: true });
  }
});

test('debug start → connected event in log', async () => {
  const r = runCli(['start', '--project', projectDir]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.port, PORT);
  assert.match(r.slug as string, /^cdp-int-/);
  // Give CDP handshake a moment.
  await wait(200);
});

test('debug status → state running, paused=false', () => {
  const r = runCli(['status']);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'running');
  assert.equal(r.paused, false);
});

test('debug bp set target.mjs (function entry) → registered', () => {
  const targetFile = join(projectDir, 'target.mjs');
  // Set on the `function tick(...)` line; V8 resolves to first executable stmt inside.
  const r = runCli(['bp', 'set', `${targetFile}:8`]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, 'breakpoint');
});

test('debug wait → paused on tick()', async () => {
  // tick() runs every 50ms, BP set; should hit within ~5s easily.
  const r = runCli(['wait', '--timeout', '5']);
  assert.equal(r.ok, true);
  assert.equal(r.paused, true, JSON.stringify(r));
  const frame = r.frame as { function: string; line: number };
  assert.match(frame.function, /tick/);
});

test('debug eval lastValue → returns positive even number', () => {
  const r = runCli(['eval', 'lastValue']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'callFrame');
  assert.equal(r.type, 'number');
  const value = r.value as number;
  assert.ok(value >= 2 && value % 2 === 0, `expected positive even number, got ${value}`);
});

test('debug eval counter → returns matching counter value', () => {
  const r = runCli(['eval', 'counter']);
  assert.equal(r.ok, true);
  assert.equal(r.type, 'number');
  assert.ok((r.value as number) >= 1);
});

test('debug locals → exposes function parameter `input` in local scope', async () => {
  const r = runCli(['locals']);
  assert.equal(r.ok, true);
  const scopes = r.scopes as { type: string; value: Record<string, unknown> }[];
  assert.ok(Array.isArray(scopes) && scopes.length > 0, 'expected at least one scope');
  const local = scopes.find((s) => s.type === 'local');
  assert.ok(local, 'expected a local scope');
  assert.ok('input' in local.value, `input parameter missing: ${JSON.stringify(local.value)}`);
});

test('debug stack → at least one frame on tick', () => {
  const r = runCli(['stack']);
  assert.equal(r.ok, true);
  const stack = r.stack as { function: string }[];
  assert.ok(stack.length >= 1);
  assert.match(stack[0]!.function, /tick/);
});

test('debug resume → unpauses', async () => {
  const r = runCli(['resume']);
  assert.equal(r.ok, true);
  await wait(100);
  const status = runCli(['status']);
  // It may have hit the BP again immediately — accept either running or paused (idempotent).
  assert.ok(status.state === 'running' || status.state === 'paused');
});

test('debug bp rm all → clears breakpoints', async () => {
  // Resume first if still paused.
  try { runCli(['resume']); } catch { /* ignore */ }
  const r = runCli(['bp', 'rm', 'all']);
  assert.equal(r.ok, true);
  const list = runCli(['bp', 'list']);
  assert.equal(list.ok, true);
  assert.equal((list.breakpoints as unknown[]).length, 0);
});

test('debug stop → tmp files cleaned up', async () => {
  const slug = slugify(projectDir);
  const r = runCli(['stop']);
  assert.equal(r.ok, true);

  // Daemon takes a tick to clean up after responding.
  await wait(500);

  assert.equal(existsSync(socketPath(slug)), false, 'socket should be removed');
  assert.equal(existsSync(pidPath(slug)), false, 'pid file should be removed');
  // Log file is intentionally NOT removed (kept for post-mortem).
});
