import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, openSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detect, findProjectRoot, slugify } from './detect.js';
import { ipcRequest, isSocketAlive, socketPath, logPath } from './ipc.js';
import type { ProjectConfig } from './types.js';
import { runDoctor } from './doctor-main.js';

interface ParsedArgs {
  project?: string;
  reattach?: boolean;
  all?: boolean;
  cond?: string;
  log?: string;
  depth?: number;
  frame?: number;
  timeout?: number;
  idleTimeout?: number;
}

function out(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function err(msg: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2));
  process.exit(1);
}

function ensureDeps(skillRoot: string): void {
  // chrome-remote-interface and source-map are bundled into dist/cli.js;
  // this check is a safety net for edge cases where the bundle wasn't produced.
  const cli = join(skillRoot, 'dist', 'cli.js');
  if (existsSync(cli)) return;
  const r = spawnSync('npm', ['install', '--prefix', skillRoot, '--loglevel=error'], { encoding: 'utf8' });
  if (r.status !== 0) {
    err(`Failed to install skill deps: ${r.stderr || r.stdout}`);
  }
  const r2 = spawnSync('npm', ['run', 'build', '--prefix', skillRoot], { encoding: 'utf8' });
  if (r2.status !== 0) {
    err(`Failed to build: ${r2.stderr || r2.stdout}`);
  }
}

async function getProjectConfig(args: ParsedArgs): Promise<ProjectConfig> {
  const projectArg = args.project ? resolve(args.project) : null;
  const cwd = projectArg ?? process.cwd();
  try {
    return await detect(cwd);
  } catch (e) {
    err((e as Error).message);
  }
}

async function findDaemonForCwd(): Promise<{ slug: string; sock: string } | null> {
  const root = findProjectRoot(process.cwd());
  if (!root) return null;
  const slug = slugify(root);
  const sock = socketPath(slug);
  if (await isSocketAlive(sock)) return { slug, sock };
  return null;
}

async function findDaemonBySlug(slug: string): Promise<{ slug: string; sock: string } | null> {
  const sock = socketPath(slug);
  if (await isSocketAlive(sock)) return { slug, sock };
  return null;
}

interface ContainerCheck {
  running: boolean;
  skipped?: string;
  error?: string;
  found?: string[];
}

function checkContainer(name: string | null): ContainerCheck {
  if (!name) return { running: true, skipped: 'no-container' };
  const r = spawnSync('docker', ['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (r.status !== 0) return { running: false, error: `docker ps failed: ${r.stderr}` };
  const found = (r.stdout || '').trim().split('\n').filter(Boolean);
  return { running: found.includes(name), found };
}

async function checkInspector(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForLogEvent(
  slug: string,
  predicate: (evt: Record<string, unknown>) => boolean,
  { timeoutMs = 8000 }: { timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
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
            const evt = JSON.parse(line) as Record<string, unknown>;
            if (predicate(evt)) return evt;
          } catch {
            /* ignore */
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function cmdStart(args: ParsedArgs, selfPath: string, skillRoot: string): Promise<void> {
  ensureDeps(skillRoot);
  const cfg = await getProjectConfig(args);
  const existing = await findDaemonBySlug(cfg.slug);
  if (existing) {
    const status = await ipcRequest(existing.sock, { cmd: 'status' });
    out({ ok: true, alreadyRunning: true, status });
    return;
  }
  const containerCheck = checkContainer(cfg.container);
  if (cfg.container && !containerCheck.running) {
    err(`Container '${cfg.container}' is not running. Start it with: docker start ${cfg.container}`, {
      container: cfg.container,
      command: `docker start ${cfg.container}`,
    });
  }
  const inspectorOk = await checkInspector(cfg.host, cfg.port);
  if (!inspectorOk) {
    const recovery = cfg.container
      ? `docker start ${cfg.container}  # then wait a few seconds for the inspector to bind`
      : `start the Node process with --inspect=${cfg.port}`;
    err(`Node Inspector not listening on ${cfg.host}:${cfg.port}. ${recovery}`, {
      port: cfg.port,
      container: cfg.container,
      recovery,
    });
  }
  const daemonOut = openSync(`/tmp/claude-debug-${cfg.slug}.daemon.log`, 'a');
  const daemonArgs = ['__daemon', '--project', cfg.projectRoot];
  if (args.reattach) daemonArgs.push('--reattach');
  if (args.idleTimeout) daemonArgs.push('--idle-timeout', String(args.idleTimeout));
  const child = spawn(process.execPath, [selfPath, ...daemonArgs], {
    detached: true,
    stdio: ['ignore', daemonOut, daemonOut],
    cwd: cfg.projectRoot,
  });
  child.unref();
  const evt = await waitForLogEvent(
    cfg.slug,
    (e) => e.event === 'connected' || e.event === 'connect-failed',
    { timeoutMs: 10_000 },
  );
  if (!evt) {
    err(`Daemon did not emit connected/failed event within timeout. Check /tmp/claude-debug-${cfg.slug}.daemon.log`);
  }
  if (evt.event === 'connect-failed') {
    err(`Daemon failed to connect: ${String(evt.error)}`, { recovery: evt.recovery });
  }
  out({
    ok: true,
    slug: cfg.slug,
    pid: child.pid,
    project: cfg.projectRoot,
    port: cfg.port,
    container: cfg.container,
    runtime: cfg.runtime,
    log: logPath(cfg.slug),
    socket: socketPath(cfg.slug),
  });
}

interface DaemonEntry {
  slug: string;
  pid: number | null;
  alive: boolean;
  socket: string;
  log: string;
}

function listDaemons(): DaemonEntry[] {
  const dir = '/tmp';
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const result: DaemonEntry[] = [];
  for (const f of entries) {
    const m = /^claude-debug-(.+)\.pid$/.exec(f);
    if (!m) continue;
    const slug = m[1]!;
    let pid: number | null = null;
    try {
      pid = Number(readFileSync(join(dir, f), 'utf8').trim());
    } catch {
      /* ignore */
    }
    let alive = false;
    if (pid) {
      try { process.kill(pid, 0); alive = true; } catch { /* ignore */ }
    }
    result.push({ slug, pid, alive, socket: socketPath(slug), log: logPath(slug) });
  }
  return result;
}

async function cmdStop(args: ParsedArgs): Promise<void> {
  if (args.all) {
    const slugs = listDaemons().map((d) => d.slug);
    const stopped: string[] = [];
    for (const slug of slugs) {
      const sock = socketPath(slug);
      if (await isSocketAlive(sock)) {
        try {
          await ipcRequest(sock, { cmd: 'stop' }, { timeoutMs: 3000 });
          stopped.push(slug);
        } catch {
          /* ignore */
        }
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

async function cmdStatus(): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon running for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'status' });
  out(r);
}

async function cmdLs(): Promise<void> {
  const daemons = listDaemons();
  const enriched = await Promise.all(
    daemons.map(async (d) => {
      const sockAlive = await isSocketAlive(d.socket);
      let status: unknown = null;
      if (sockAlive) {
        try { status = await ipcRequest(d.socket, { cmd: 'status' }, { timeoutMs: 2000 }); } catch { /* ignore */ }
      }
      return { ...d, sockAlive, status };
    }),
  );
  out({ ok: true, daemons: enriched });
}

async function cmdTail(): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  out({ ok: true, log: logPath(target.slug), tailCommand: `tail -F ${logPath(target.slug)}` });
}

async function cmdBpSet(args: ParsedArgs & { target?: string }): Promise<void> {
  if (!args.target) err('Usage: cdp bp set <file>:<line> [--cond <expr>] [--log <expr>]');
  const m = /^(.+):(\d+)$/.exec(args.target);
  if (!m) err('Target must be <file>:<line>');
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const file = m[1]!;
  const line = Number(m[2]);
  const r = await ipcRequest(target.sock, { cmd: 'bp.set', file, line, cond: args.cond ?? null, logExpr: args.log ?? null });
  out(r);
}

async function cmdBpList(): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'bp.list' });
  out(r);
}

async function cmdBpRm(args: ParsedArgs & { id?: string }): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'bp.rm', id: args.id });
  out(r);
}

async function cmdWait(args: ParsedArgs): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const timeout = Number(args.timeout ?? 30);
  const r = await ipcRequest(target.sock, { cmd: 'wait', timeout }, { timeoutMs: (timeout + 5) * 1000 });
  out(r);
}

async function cmdEval(args: ParsedArgs & { expr?: string }): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, {
    cmd: 'eval',
    expr: args.expr,
    depth: args.depth ?? 2,
    frame: args.frame ?? 0,
  });
  out(r);
}

async function cmdLocals(args: ParsedArgs): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'locals', depth: args.depth ?? 2 });
  out(r);
}

async function cmdStack(): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'stack' });
  out(r);
}

async function cmdStep(direction: string): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'step', direction });
  out(r);
}

async function cmdResume(): Promise<void> {
  const target = await findDaemonForCwd();
  if (!target) err('No daemon for current project. Run `cdp start` first.');
  const r = await ipcRequest(target.sock, { cmd: 'resume' });
  out(r);
}

function parseArgs(argv: string[]): { args: ParsedArgs; positional: string[] } {
  const args: ParsedArgs = {};
  const positional: string[] = [];
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
    else if (a !== undefined) positional.push(a);
  }
  return { args, positional };
}

const HELP = `cdp — CDP debugger CLI

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

All commands return JSON.`;

export async function runCli(argv: string[], selfPath: string, skillRoot: string): Promise<void> {
  const command = argv[0];
  const { args, positional } = parseArgs(argv.slice(1));

  try {
    switch (command) {
      case 'start': await cmdStart(args, selfPath, skillRoot); break;
      case 'stop': await cmdStop(args); break;
      case 'status': await cmdStatus(); break;
      case 'ls': await cmdLs(); break;
      case 'tail': await cmdTail(); break;
      case 'doctor': process.exit(runDoctor(skillRoot));
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
      case 'step': await cmdStep(positional[0] ?? 'over'); break;
      case 'resume': await cmdResume(); break;
      case undefined:
      case 'help':
        console.log(HELP);
        break;
      default:
        err(`Unknown command: ${command}. Try 'cdp help'.`);
    }
  } catch (e) {
    err((e as Error).message, { stack: (e as Error).stack });
  }
}
