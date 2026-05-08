#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, openSync, readdirSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { detect, findProjectRoot, slugify } from '../lib/detect.mjs';
import { ipcRequest, isSocketAlive, socketPath, pidPath, logPath, bpsPath } from '../lib/ipc.mjs';

const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAEMON_SCRIPT = join(SKILL_ROOT, 'bin', 'debug-daemon.mjs');

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function err(msg, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2));
  process.exit(1);
}

async function ensureDeps() {
  const crii = join(SKILL_ROOT, 'node_modules', 'chrome-remote-interface', 'package.json');
  if (existsSync(crii)) return;
  const r = spawnSync('npm', ['install', '--omit=dev', '--prefix', SKILL_ROOT, '--loglevel=error'], { encoding: 'utf8' });
  if (r.status !== 0) {
    err(`Failed to install skill deps: ${r.stderr || r.stdout}`);
  }
}

async function getProjectConfig(args) {
  const projectArg = args.project ? resolve(args.project) : null;
  const cwd = projectArg ?? process.cwd();
  try {
    return await detect(cwd);
  } catch (e) {
    err(e.message);
  }
}

async function findDaemonForCwd() {
  const root = await findProjectRoot(process.cwd());
  if (!root) return null;
  const slug = slugify(root);
  const sock = socketPath(slug);
  if (await isSocketAlive(sock)) return { slug, sock };
  return null;
}

async function findDaemonBySlug(slug) {
  const sock = socketPath(slug);
  if (await isSocketAlive(sock)) return { slug, sock };
  return null;
}

function checkContainer(name) {
  if (!name) return { running: true, skipped: 'no-container' };
  const r = spawnSync('docker', ['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (r.status !== 0) return { running: false, error: `docker ps failed: ${r.stderr}` };
  const found = (r.stdout || '').trim().split('\n').filter(Boolean);
  return { running: found.includes(name), found };
}

async function checkInspector(host, port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForLogEvent(slug, predicate, { timeoutMs = 8000 } = {}) {
  const path = logPath(slug);
  const start = Date.now();
  let offset = existsSync(path) ? statSync(path).size : 0;
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > offset) {
        const buf = readFileSync(path).toString('utf8').slice(offset);
        offset = size;
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (predicate(evt)) return evt;
          } catch { /* ignore */ }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function cmdStart(args) {
  await ensureDeps();
  const cfg = await getProjectConfig(args);
  const existing = await findDaemonBySlug(cfg.slug);
  if (existing) {
    const status = await ipcRequest(existing.sock, { cmd: 'status' });
    out({ ok: true, alreadyRunning: true, status });
    return;
  }
  const containerCheck = checkContainer(cfg.container);
  if (cfg.container && !containerCheck.running) {
    err(`Container '${cfg.container}' is not running. Start it with: docker start ${cfg.container}`, { container: cfg.container, command: `docker start ${cfg.container}` });
  }
  const inspectorOk = await checkInspector(cfg.host, cfg.port);
  if (!inspectorOk) {
    const recovery = cfg.container
      ? `docker start ${cfg.container}  # then wait a few seconds for the inspector to bind`
      : `start the Node process with --inspect=${cfg.port}`;
    err(`Node Inspector not listening on ${cfg.host}:${cfg.port}. ${recovery}`, { port: cfg.port, container: cfg.container, recovery });
  }
  const daemonOut = openSync(`/tmp/claude-debug-${cfg.slug}.daemon.log`, 'a');
  const daemonArgs = ['--project', cfg.projectRoot];
  if (args.reattach) daemonArgs.push('--reattach');
  if (args.idleTimeout) daemonArgs.push('--idle-timeout', String(args.idleTimeout));
  const child = spawn(process.execPath, [DAEMON_SCRIPT, ...daemonArgs], {
    detached: true,
    stdio: ['ignore', daemonOut, daemonOut],
    cwd: cfg.projectRoot,
  });
  child.unref();
  const evt = await waitForLogEvent(cfg.slug, (e) => e.event === 'connected' || e.event === 'connect-failed', { timeoutMs: 10_000 });
  if (!evt) {
    err(`Daemon did not emit connected/failed event within timeout. Check /tmp/claude-debug-${cfg.slug}.daemon.log`);
  }
  if (evt.event === 'connect-failed') {
    err(`Daemon failed to connect: ${evt.error}`, { recovery: evt.recovery });
  }
  out({ ok: true, slug: cfg.slug, pid: child.pid, project: cfg.projectRoot, port: cfg.port, container: cfg.container, runtime: cfg.runtime, log: logPath(cfg.slug), socket: socketPath(cfg.slug) });
}

async function cmdStop(args) {
  if (args.all) {
    const slugs = listDaemons().map((d) => d.slug);
    const stopped = [];
    for (const slug of slugs) {
      const sock = socketPath(slug);
      if (await isSocketAlive(sock)) {
        try { await ipcRequest(sock, { cmd: 'stop' }, { timeoutMs: 3000 }); stopped.push(slug); } catch { /* ignore */ }
      }
    }
    out({ ok: true, stopped });
    return;
  }
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Use --all to stop everything.');
  const r = await ipcRequest(target.sock, { cmd: 'stop' }, { timeoutMs: 3000 });
  out(r);
}

async function cmdStatus() {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon running for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'status' });
  out(r);
}

function listDaemons() {
  const dir = '/tmp';
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of entries) {
    const m = f.match(/^claude-debug-(.+)\.pid$/);
    if (!m) continue;
    const slug = m[1];
    let pid = null;
    try { pid = Number(readFileSync(join(dir, f), 'utf8').trim()); } catch { /* ignore */ }
    let alive = false;
    if (pid) {
      try { process.kill(pid, 0); alive = true; } catch { /* ignore */ }
    }
    out.push({ slug, pid, alive, socket: socketPath(slug), log: logPath(slug) });
  }
  return out;
}

async function cmdLs() {
  const daemons = listDaemons();
  const enriched = await Promise.all(daemons.map(async (d) => {
    const sockAlive = await isSocketAlive(d.socket);
    let status = null;
    if (sockAlive) {
      try { status = await ipcRequest(d.socket, { cmd: 'status' }, { timeoutMs: 2000 }); } catch { /* ignore */ }
    }
    return { ...d, sockAlive, status };
  }));
  out({ ok: true, daemons: enriched });
}

async function cmdTail() {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  out({ ok: true, log: logPath(target.slug), tailCommand: `tail -F ${logPath(target.slug)}` });
}

async function cmdDoctor() {
  const r = spawnSync(process.execPath, [join(SKILL_ROOT, 'bin', 'doctor.mjs')], { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.status ?? 0);
}

async function cmdBpSet(args) {
  if (!args.target) err('Usage: debug bp set <file>:<line> [--cond <expr>] [--log <expr>]');
  const m = args.target.match(/^(.+):(\d+)$/);
  if (!m) err('Target must be <file>:<line>');
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const file = m[1];
  const line = Number(m[2]);
  const r = await ipcRequest(target.sock, { cmd: 'bp.set', file, line, cond: args.cond ?? null, logExpr: args.log ?? null });
  out(r);
}

async function cmdBpList() {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'bp.list' });
  out(r);
}

async function cmdBpRm(args) {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'bp.rm', id: args.id });
  out(r);
}

async function cmdWait(args) {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const timeout = Number(args.timeout ?? 30);
  const r = await ipcRequest(target.sock, { cmd: 'wait', timeout }, { timeoutMs: (timeout + 5) * 1000 });
  out(r);
}

async function cmdEval(args) {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'eval', expr: args.expr, depth: args.depth ?? 2, frame: args.frame ?? 0 });
  out(r);
}

async function cmdLocals(args) {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'locals', depth: args.depth ?? 2 });
  out(r);
}

async function cmdStack() {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'stack' });
  out(r);
}

async function cmdStep(direction) {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'step', direction });
  out(r);
}

async function cmdResume() {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `debug start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'resume' });
  out(r);
}

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--reattach') args.reattach = true;
    else if (a === '--all') args.all = true;
    else if (a === '--cond') args.cond = argv[++i];
    else if (a === '--log') args.log = argv[++i];
    else if (a === '--depth') args.depth = Number(argv[++i]);
    else if (a === '--frame') args.frame = Number(argv[++i]);
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--idle-timeout') args.idleTimeout = Number(argv[++i]);
    else positional.push(a);
  }
  return { args, positional };
}

const argv = process.argv.slice(2);
const command = argv[0];
const { args, positional } = parseArgs(argv.slice(1));

try {
  switch (command) {
    case 'start': await cmdStart(args); break;
    case 'stop': await cmdStop(args); break;
    case 'status': await cmdStatus(); break;
    case 'ls': await cmdLs(); break;
    case 'tail': await cmdTail(); break;
    case 'doctor': await cmdDoctor(); break;
    case 'bp': {
      const sub = positional[0];
      if (sub === 'set') await cmdBpSet({ ...args, target: positional[1] });
      else if (sub === 'list') await cmdBpList();
      else if (sub === 'rm') await cmdBpRm({ ...args, id: positional[1] });
      else err(`Unknown bp subcommand: ${sub}. Use: set | list | rm`);
      break;
    }
    case 'wait': await cmdWait(args); break;
    case 'eval': await cmdEval({ ...args, expr: positional.join(' ') }); break;
    case 'locals': await cmdLocals(args); break;
    case 'stack': await cmdStack(); break;
    case 'step': await cmdStep(positional[0] || 'over'); break;
    case 'resume': await cmdResume(); break;
    case undefined:
    case 'help':
      console.log(`debug — CDP debugger CLI

Commands:
  start [--project DIR] [--reattach] [--idle-timeout SEC]
  stop [--all]
  status
  ls
  tail
  doctor

  bp set <file>:<line> [--cond <expr>] [--log <expr>]
  bp list
  bp rm <id|all>

  wait [--timeout SEC]
  eval <expr> [--depth N] [--frame N]
  locals [--depth N]
  stack
  step [over|in|out]
  resume

All commands return JSON.`);
      break;
    default:
      err(`Unknown command: ${command}. Try 'debug help'.`);
  }
} catch (e) {
  err(e.message, { stack: e.stack });
}
