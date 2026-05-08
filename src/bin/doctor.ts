#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// dist/bin/doctor.js → up two = dist/, up three = repo root
const SKILL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

function check(name: string, fn: () => Record<string, unknown>): CheckResult {
  try {
    const result = fn();
    return { name, ok: true, ...result };
  } catch (err) {
    return { name, ok: false, error: (err as Error).message };
  }
}

function nodeVersion(): Record<string, unknown> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error(`Node ${process.versions.node} found, need >= 22`);
  return { version: process.versions.node };
}

function depsInstalled(): Record<string, unknown> {
  const crii = join(SKILL_ROOT, 'node_modules', 'chrome-remote-interface', 'package.json');
  const sm = join(SKILL_ROOT, 'node_modules', 'source-map', 'package.json');
  if (!existsSync(crii) || !existsSync(sm)) {
    throw new Error('chrome-remote-interface or source-map missing — run `npm install` in ' + SKILL_ROOT);
  }
  return { skillRoot: SKILL_ROOT };
}

function autoInstall(): Record<string, unknown> {
  const crii = join(SKILL_ROOT, 'node_modules', 'chrome-remote-interface', 'package.json');
  if (existsSync(crii)) return { installed: false, reason: 'already-present' };
  const r = spawnSync('npm', ['install', '--omit=dev', '--prefix', SKILL_ROOT, '--loglevel=error'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm install failed: ${r.stderr || r.stdout}`);
  return { installed: true };
}

function distBuilt(): Record<string, unknown> {
  const debugJs = join(SKILL_ROOT, 'dist', 'bin', 'debug.js');
  const daemonJs = join(SKILL_ROOT, 'dist', 'bin', 'debug-daemon.js');
  if (!existsSync(debugJs) || !existsSync(daemonJs)) {
    throw new Error(`Build artifacts missing in ${join(SKILL_ROOT, 'dist')} — run \`npm run build\``);
  }
  return { dist: join(SKILL_ROOT, 'dist') };
}

function unixSocketTooling(): Record<string, unknown> {
  const havesocat = spawnSync('which', ['socat'], { encoding: 'utf8' });
  const havecurl = spawnSync('curl', ['--version'], { encoding: 'utf8' });
  const curlHasUnix = /UnixSockets/i.test(havecurl.stdout || '');
  if (havesocat.status === 0) return { socat: havesocat.stdout.trim() };
  if (curlHasUnix) return { curlUnixSocket: true };
  throw new Error('Need socat OR curl with UnixSockets feature');
}

function inspectorReachableSample(): Record<string, unknown> {
  const envPorts = (process.env.DEBUG_INSPECTOR_PORTS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  const ports = envPorts.length > 0 ? envPorts : [9229];
  const reachable: number[] = [];
  for (const p of ports) {
    const r = spawnSync('curl', ['-sf', '--max-time', '0.5', `http://127.0.0.1:${p}/json/version`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) reachable.push(p);
  }
  return {
    reachable,
    scanned: ports,
    note: reachable.length === 0 ? 'No inspector ports listening — start your Node process with --inspect (or its container) before debugging' : null,
  };
}

const results: CheckResult[] = [
  check('node-version', nodeVersion),
  check('auto-install', autoInstall),
  check('deps-installed', depsInstalled),
  check('dist-built', distBuilt),
  check('unix-socket-tools', unixSocketTooling),
  check('inspector-sample', inspectorReachableSample),
];

const allOk = results.every((r) => r.ok || r.name === 'inspector-sample');
const out = { ok: allOk, skillRoot: SKILL_ROOT, checks: results };
console.log(JSON.stringify(out, null, 2));
process.exit(allOk ? 0 : 1);
