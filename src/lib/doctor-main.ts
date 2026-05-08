import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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

function distBuilt(skillRoot: string): Record<string, unknown> {
  const cli = join(skillRoot, 'dist', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error(`Build artifact missing at ${cli} — run \`npm run build\``);
  }
  return { dist: join(skillRoot, 'dist') };
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

export function runDoctor(skillRoot: string): number {
  const results: CheckResult[] = [
    check('node-version', nodeVersion),
    check('dist-built', () => distBuilt(skillRoot)),
    check('unix-socket-tools', unixSocketTooling),
    check('inspector-sample', inspectorReachableSample),
  ];
  const allOk = results.every((r) => r.ok || r.name === 'inspector-sample');
  const out = { ok: allOk, skillRoot, checks: results };
  console.log(JSON.stringify(out, null, 2));
  return allOk ? 0 : 1;
}
