import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detect,
  findProjectRoot,
  localToRemote,
  parseJsonc,
  remoteToLocal,
  slugify,
} from '../src/lib/detect.js';

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'cdp-debug-test-'));
}

test('parseJsonc: strips // and /* */ comments + trailing commas', () => {
  const raw = `{
    // a line comment
    "name": "test", /* block */
    "list": [1, 2, 3,],
  }`;
  const parsed = parseJsonc(raw) as { name: string; list: number[] };
  assert.equal(parsed.name, 'test');
  assert.deepEqual(parsed.list, [1, 2, 3]);
});

test('slugify: strips non-alphanum, lowercases, dedups dashes', () => {
  assert.equal(slugify('/home/me/My_Cool.Project'), 'my-cool-project');
  assert.equal(slugify('/home/me/foo--bar'), 'foo-bar');
  assert.equal(slugify('/home/me/123-abc'), '123-abc');
});

test('localToRemote / remoteToLocal: round-trip', () => {
  const cfg = { localRoot: '/home/me/proj', remoteRoot: '/app' };
  const local = '/home/me/proj/src/user.controller.ts';
  const remote = localToRemote(local, cfg);
  assert.equal(remote, '/app/src/user.controller.ts');
  assert.equal(remoteToLocal(remote, cfg), local);
});

test('localToRemote: throws on path outside localRoot', () => {
  const cfg = { localRoot: '/home/me/proj', remoteRoot: '/app' };
  assert.throws(() => localToRemote('/etc/passwd', cfg), /outside localRoot/);
});

test('remoteToLocal: returns null for paths outside remoteRoot', () => {
  const cfg = { localRoot: '/home/me/proj', remoteRoot: '/app' };
  assert.equal(remoteToLocal('/usr/bin/node', cfg), null);
});

test('remoteToLocal: strips file:// prefix', () => {
  const cfg = { localRoot: '/home/me/proj', remoteRoot: '/app' };
  assert.equal(remoteToLocal('file:///app/src/foo.js', cfg), '/home/me/proj/src/foo.js');
});

test('findProjectRoot: walks up to find .vscode/launch.json', () => {
  const tmp = freshTmp();
  try {
    const sub = join(tmp, 'src', 'a', 'b');
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(tmp, '.vscode'));
    writeFileSync(join(tmp, '.vscode', 'launch.json'), '{"configurations":[]}');
    assert.equal(findProjectRoot(sub), tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findProjectRoot: returns null when no launch.json found', () => {
  const tmp = freshTmp();
  try {
    assert.equal(findProjectRoot(tmp), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detect: parses attach config + extracts container from preLaunchTask', async () => {
  const tmp = freshTmp();
  try {
    mkdirSync(join(tmp, '.vscode'));
    writeFileSync(
      join(tmp, '.vscode', 'launch.json'),
      JSON.stringify({
        configurations: [
          {
            name: 'attach',
            request: 'attach',
            port: 9229,
            localRoot: '${workspaceFolder}',
            remoteRoot: '/app',
            preLaunchTask: 'docker-up',
          },
        ],
      }),
    );
    writeFileSync(
      join(tmp, '.vscode', 'tasks.json'),
      JSON.stringify({
        tasks: [{ label: 'docker-up', command: 'docker', args: ['start', 'my-api'] }],
      }),
    );
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: {} }));
    const cfg = await detect(tmp);
    assert.equal(cfg.port, 9229);
    assert.equal(cfg.localRoot, tmp);
    assert.equal(cfg.remoteRoot, '/app');
    assert.equal(cfg.container, 'my-api');
    assert.equal(cfg.attachConfigName, 'attach');
    assert.equal(cfg.preLaunchTask, 'docker-up');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detect: runtime=ts-node when start script uses tsx/nest start', async () => {
  const tmp = freshTmp();
  try {
    mkdirSync(join(tmp, '.vscode'));
    writeFileSync(
      join(tmp, '.vscode', 'launch.json'),
      JSON.stringify({ configurations: [{ request: 'attach', port: 9229 }] }),
    );
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ scripts: { 'start:debug': 'nest start --debug --watch' } }),
    );
    const cfg = await detect(tmp);
    assert.equal(cfg.runtime, 'ts-node');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detect: throws helpful error when no launch.json', async () => {
  const tmp = freshTmp();
  try {
    await assert.rejects(() => detect(tmp), /No \.vscode\/launch\.json/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
