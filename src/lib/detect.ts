import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, resolve, dirname, relative } from 'node:path';
import type {
  AttachConfig,
  LaunchJson,
  ProjectConfig,
  Runtime,
  Task,
  TasksJson,
} from './types.js';

const STRIP_COMMENTS = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
const STRIP_TRAILING_COMMA = /,(\s*[}\]])/g;

/**
 * Tolerant JSON parser used for `.vscode/launch.json` and `.vscode/tasks.json`
 * which permit `//` and `/* *\/` comments and trailing commas.
 */
export function parseJsonc(raw: string): unknown {
  const cleaned = raw.replace(STRIP_COMMENTS, '').replace(STRIP_TRAILING_COMMA, '$1');
  return JSON.parse(cleaned);
}

/**
 * Walks up from `startCwd` until it finds a directory containing
 * `.vscode/launch.json`. Returns the absolute path of that directory or `null`
 * if no such ancestor exists.
 */
export function findProjectRoot(startCwd: string): string | null {
  let dir = resolve(startCwd);
  while (true) {
    if (existsSync(join(dir, '.vscode', 'launch.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Derives a filesystem-safe slug from a project's absolute path. Used to
 * namespace per-project files in `/tmp/claude-debug-<slug>.*`.
 */
export function slugify(absolutePath: string): string {
  return basename(absolutePath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function readJsonc<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return parseJsonc(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
}

function pickAttachConfig(launchJson: LaunchJson | null): AttachConfig | null {
  const configs = launchJson?.configurations ?? [];
  const attach = configs.find((c) => c.request === 'attach' && (c.port ?? c.attachSimplePort));
  if (attach) return attach;
  const launchWithSimple = configs.find((c) => c.attachSimplePort);
  return launchWithSimple ?? null;
}

function extractContainerFromTask(tasksJson: TasksJson | null, taskLabel: string | undefined): string | null {
  if (!tasksJson || !taskLabel) return null;
  const task = (tasksJson.tasks ?? []).find((t: Task) => t.label === taskLabel);
  if (!task) return null;
  const args = task.args ?? [];
  const cmd = task.command;
  if (cmd === 'docker') {
    const startIdx = args.indexOf('start');
    if (startIdx >= 0 && args[startIdx + 1]) return args[startIdx + 1] ?? null;
    const runNameIdx = args.indexOf('--name');
    if (runNameIdx >= 0 && args[runNameIdx + 1]) return args[runNameIdx + 1] ?? null;
  }
  return null;
}

async function detectRuntime(projectRoot: string): Promise<Runtime> {
  const startScript = await readStartScript(projectRoot);
  if (startScript) {
    if (/\bnode\s+[^&|;]*\bdist\//.test(startScript)) return 'compiled';
    if (/\bnest\s+start\b|\bts-node\b|\btsx\b/.test(startScript)) return 'ts-node';
  }
  const bootstrap = await readBootstrap(projectRoot);
  if (bootstrap) {
    if (/\bnode\s+[^&|;]*\bdist\//.test(bootstrap)) return 'compiled';
    if (/\bnest\s+start\b|\bts-node\b|\btsx\b/.test(bootstrap)) return 'ts-node';
  }
  const distPath = join(projectRoot, 'dist');
  if (!existsSync(distPath)) return 'ts-node';
  try {
    const entries = await walkForMaps(distPath, 0, 3);
    return entries.length > 0 ? 'compiled' : 'ts-node';
  } catch {
    return 'ts-node';
  }
}

async function readStartScript(projectRoot: string): Promise<string | null> {
  try {
    const pkgRaw = await readFile(join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return scripts['start:debug'] ?? scripts.start ?? null;
  } catch {
    return null;
  }
}

async function readBootstrap(projectRoot: string): Promise<string | null> {
  try {
    return await readFile(join(projectRoot, 'bootstrap.sh'), 'utf8');
  } catch {
    return null;
  }
}

async function walkForMaps(dir: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    if (e.name.endsWith('.js.map')) {
      found.push(join(dir, e.name));
      if (found.length > 0) return found;
    } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      const nested = await walkForMaps(join(dir, e.name), depth + 1, maxDepth);
      if (nested.length > 0) return nested;
    }
  }
  return found;
}

async function detectInspectorBrk(projectRoot: string): Promise<boolean> {
  try {
    const pkgRaw = await readFile(join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const allScripts = Object.values(scripts).join(' ');
    return allScripts.includes('--inspect-brk');
  } catch {
    return false;
  }
}

/**
 * Discovers and resolves a {@link ProjectConfig} for the project containing
 * `cwd`. Walks up to find `.vscode/launch.json`, picks an `attach` config,
 * cross-references `tasks.json` for a Docker container, and detects the
 * runtime style (compiled vs ts-node).
 *
 * Throws with a helpful message if any required piece is missing.
 */
export async function detect(cwd: string): Promise<ProjectConfig> {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    throw new Error(`No .vscode/launch.json found at or above ${cwd}`);
  }
  const launchJson = await readJsonc<LaunchJson>(join(projectRoot, '.vscode', 'launch.json'));
  if (!launchJson) {
    throw new Error(`Missing .vscode/launch.json at ${projectRoot}`);
  }
  const tasksJson = await readJsonc<TasksJson>(join(projectRoot, '.vscode', 'tasks.json'));
  const attach = pickAttachConfig(launchJson);
  if (!attach) {
    throw new Error(`No attach config in ${projectRoot}/.vscode/launch.json`);
  }

  const port = attach.port ?? attach.attachSimplePort;
  if (!port) throw new Error(`Attach config has no port: ${JSON.stringify(attach)}`);

  const expandWorkspace = (s: string): string =>
    s.replace('${workspaceFolder}', projectRoot).replace('${workspaceRoot}', projectRoot);
  const localRoot = expandWorkspace(attach.localRoot ?? '${workspaceFolder}');
  const remoteRoot = expandWorkspace(attach.remoteRoot ?? '/app');

  const container = extractContainerFromTask(tasksJson, attach.preLaunchTask);
  const runtime = await detectRuntime(projectRoot);
  const inspectorBrk = await detectInspectorBrk(projectRoot);

  return {
    projectRoot,
    slug: slugify(projectRoot),
    port,
    host: '127.0.0.1',
    localRoot,
    remoteRoot,
    container,
    runtime,
    inspectorBrk,
    attachConfigName: attach.name ?? null,
    preLaunchTask: attach.preLaunchTask ?? null,
  };
}

/**
 * Translates an absolute local source path into the remote path the inspector
 * reports. Throws if `absLocalPath` is not under `cfg.localRoot`.
 */
export function localToRemote(absLocalPath: string, cfg: { localRoot: string; remoteRoot: string }): string {
  const rel = relative(cfg.localRoot, absLocalPath);
  if (rel.startsWith('..')) {
    throw new Error(`Path ${absLocalPath} is outside localRoot ${cfg.localRoot}`);
  }
  return `${cfg.remoteRoot.replace(/\/$/, '')}/${rel.split('\\').join('/')}`;
}

/**
 * Reverse of {@link localToRemote}. Returns `null` for paths outside
 * `cfg.remoteRoot` (e.g., Node internal scripts, npm packages outside the project).
 */
export function remoteToLocal(remotePath: string, cfg: { localRoot: string; remoteRoot: string }): string | null {
  const normalizedRemote = remotePath.replace(/^file:\/\//, '');
  const cleanedRoot = cfg.remoteRoot.replace(/\/$/, '');
  if (!normalizedRemote.startsWith(cleanedRoot)) {
    return null;
  }
  const rel = normalizedRemote.slice(cleanedRoot.length).replace(/^\//, '');
  return join(cfg.localRoot, rel);
}
