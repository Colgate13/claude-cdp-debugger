import { readFile, access, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, resolve, dirname, relative } from 'node:path';

const STRIP_COMMENTS = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
const STRIP_TRAILING_COMMA = /,(\s*[}\]])/g;

function parseJsonc(raw) {
  const cleaned = raw.replace(STRIP_COMMENTS, '').replace(STRIP_TRAILING_COMMA, '$1');
  return JSON.parse(cleaned);
}

export async function findProjectRoot(startCwd) {
  let dir = resolve(startCwd);
  while (true) {
    if (existsSync(join(dir, '.vscode', 'launch.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function slugify(absolutePath) {
  return basename(absolutePath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function readJsonc(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return parseJsonc(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
}

function pickAttachConfig(launchJson) {
  const configs = launchJson?.configurations ?? [];
  const attach = configs.find((c) => c.request === 'attach' && (c.port || c.attachSimplePort));
  if (attach) return attach;
  const launchWithSimple = configs.find((c) => c.attachSimplePort);
  return launchWithSimple ?? null;
}

function extractContainerFromTask(tasksJson, taskLabel) {
  if (!tasksJson || !taskLabel) return null;
  const task = (tasksJson.tasks ?? []).find((t) => t.label === taskLabel);
  if (!task) return null;
  const args = task.args ?? [];
  const cmd = task.command;
  if (cmd === 'docker') {
    const startIdx = args.indexOf('start');
    if (startIdx >= 0 && args[startIdx + 1]) return args[startIdx + 1];
    const runNameIdx = args.indexOf('--name');
    if (runNameIdx >= 0 && args[runNameIdx + 1]) return args[runNameIdx + 1];
  }
  return null;
}

async function detectRuntime(projectRoot) {
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

async function readStartScript(projectRoot) {
  try {
    const pkgRaw = await readFile(join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const scripts = pkg.scripts ?? {};
    return scripts['start:debug'] ?? scripts['start'] ?? null;
  } catch {
    return null;
  }
}

async function readBootstrap(projectRoot) {
  try {
    return await readFile(join(projectRoot, 'bootstrap.sh'), 'utf8');
  } catch {
    return null;
  }
}

async function walkForMaps(dir, depth, maxDepth) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
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

async function detectInspectorBrk(projectRoot) {
  try {
    const pkgRaw = await readFile(join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const scripts = pkg.scripts ?? {};
    const allScripts = Object.values(scripts).join(' ');
    return /--inspect-brk/.test(allScripts);
  } catch {
    return false;
  }
}

export async function detect(cwd) {
  const projectRoot = await findProjectRoot(cwd);
  if (!projectRoot) {
    throw new Error(`No .vscode/launch.json found at or above ${cwd}`);
  }
  const launchJson = await readJsonc(join(projectRoot, '.vscode', 'launch.json'));
  if (!launchJson) {
    throw new Error(`Missing .vscode/launch.json at ${projectRoot}`);
  }
  const tasksJson = await readJsonc(join(projectRoot, '.vscode', 'tasks.json'));
  const attach = pickAttachConfig(launchJson);
  if (!attach) {
    throw new Error(`No attach config in ${projectRoot}/.vscode/launch.json`);
  }

  const port = attach.port ?? attach.attachSimplePort;
  if (!port) throw new Error(`Attach config has no port: ${JSON.stringify(attach)}`);

  const localRoot = (attach.localRoot ?? '${workspaceFolder}').replace('${workspaceFolder}', projectRoot).replace('${workspaceRoot}', projectRoot);
  const remoteRoot = attach.remoteRoot ?? '/app';

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

export function localToRemote(absLocalPath, { localRoot, remoteRoot }) {
  const rel = relative(localRoot, absLocalPath);
  if (rel.startsWith('..')) {
    throw new Error(`Path ${absLocalPath} is outside localRoot ${localRoot}`);
  }
  return `${remoteRoot.replace(/\/$/, '')}/${rel.split('\\').join('/')}`;
}

export function remoteToLocal(remotePath, { localRoot, remoteRoot }) {
  const normalizedRemote = remotePath.replace(/^file:\/\//, '');
  const cleanedRoot = remoteRoot.replace(/\/$/, '');
  if (!normalizedRemote.startsWith(cleanedRoot)) {
    return null;
  }
  const rel = normalizedRemote.slice(cleanedRoot.length).replace(/^\//, '');
  return join(localRoot, rel);
}
