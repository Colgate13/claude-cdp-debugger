#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function check(name, fn) {
  try {
    const result = fn();
    return { name, ok: true, ...result };
  } catch (err) {
    return { name, ok: false, error: err.message };
  }
}

function nodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error(`Node ${process.versions.node} found, need >= 22`);
  return { version: process.versions.node };
}

function depsInstalled() {
  const crii = join(SKILL_ROOT, 'node_modules', 'chrome-remote-interface', 'package.json');
  const sm = join(SKILL_ROOT, 'node_modules', 'source-map', 'package.json');
  if (!existsSync(crii) || !existsSync(sm)) {
    throw new Error('chrome-remote-interface or source-map missing — run `npm install` in ' + SKILL_ROOT);
  }
  return { skillRoot: SKILL_ROOT };
}

function autoInstall() {
  const crii = join(SKILL_ROOT, 'node_modules', 'chrome-remote-interface', 'package.json');
  if (existsSync(crii)) return { installed: false, reason: 'already-present' };
  const r = spawnSync('npm', ['install', '--omit=dev', '--prefix', SKILL_ROOT, '--loglevel=error'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm install failed: ${r.stderr || r.stdout}`);
  return { installed: true };
}

function unixSocketTooling() {
  const havesocat = spawnSync('which', ['socat'], { encoding: 'utf8' });
  const havecurl = spawnSync('curl', ['--version'], { encoding: 'utf8' });
  const curlHasUnix = /UnixSockets/i.test(havecurl.stdout || '');
  if (havesocat.status === 0) return { socat: havesocat.stdout.trim() };
  if (curlHasUnix) return { curlUnixSocket: true };
  throw new Error('Need socat OR curl with UnixSockets feature');
}

function inspectorReachableSample() {
  // Default Node Inspector port (override via DEBUG_INSPECTOR_PORTS=9229,9230,...)
  const envPorts = (process.env.DEBUG_INSPECTOR_PORTS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const ports = envPorts.length > 0 ? envPorts : [9229];
  const reachable = [];
  for (const p of ports) {
    const r = spawnSync('curl', ['-sf', '--max-time', '0.5', `http://127.0.0.1:${p}/json/version`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) reachable.push(p);
  }
  return { reachable, scanned: ports, note: reachable.length === 0 ? 'No inspector ports listening — start your Node process with --inspect (or its container) before debugging' : null };
}

const results = [
  check('node-version', nodeVersion),
  check('auto-install', autoInstall),
  check('deps-installed', depsInstalled),
  check('unix-socket-tools', unixSocketTooling),
  check('inspector-sample', inspectorReachableSample),
];

const allOk = results.every((r) => r.ok || r.name === 'inspector-sample');
const out = { ok: allOk, skillRoot: SKILL_ROOT, checks: results };
console.log(JSON.stringify(out, null, 2));
process.exit(allOk ? 0 : 1);
