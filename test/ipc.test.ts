import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { IpcServer, ipcRequest, isSocketAlive } from '../src/lib/ipc.js';

interface TestReq { cmd: string; payload?: unknown }
interface TestRes { ok: boolean; echo?: unknown; error?: string }

function tmpSocketPath(): { dir: string; sock: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-ipc-test-'));
  return { dir, sock: join(dir, 'test.sock') };
}

test('IpcServer: round-trip request/response', async () => {
  const { dir, sock } = tmpSocketPath();
  const server = new IpcServer<TestReq, TestRes>(sock, async (req) => {
    return { ok: true, echo: req.payload };
  });
  await server.start();
  try {
    assert.equal(await isSocketAlive(sock), true);
    const r = await ipcRequest<TestRes>(sock, { cmd: 'ping', payload: { x: 1 } });
    assert.deepEqual(r, { ok: true, echo: { x: 1 } });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IpcServer: handler that throws produces error response', async () => {
  const { dir, sock } = tmpSocketPath();
  const server = new IpcServer<TestReq, TestRes>(sock, async () => {
    throw new Error('boom');
  });
  await server.start();
  try {
    const r = await ipcRequest<TestRes>(sock, { cmd: 'fail' });
    assert.equal(r.ok, false);
    assert.match(r.error!, /boom/);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSocketAlive: false when no server', async () => {
  const { dir, sock } = tmpSocketPath();
  try {
    assert.equal(await isSocketAlive(sock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ipcRequest: timeout fires when server hangs', async () => {
  const { dir, sock } = tmpSocketPath();
  const server = new IpcServer<TestReq, TestRes>(sock, () => new Promise(() => {
    /* never resolves */
  }));
  await server.start();
  try {
    await assert.rejects(
      ipcRequest<TestRes>(sock, { cmd: 'hang' }, { timeoutMs: 200 }),
      /timeout/i,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IpcServer: invalid JSON produces structured error', async () => {
  const { dir, sock } = tmpSocketPath();
  const server = new IpcServer<TestReq, TestRes>(sock, async () => ({ ok: true }));
  await server.start();
  try {
    const { connect } = await import('node:net');
    const result = await new Promise<string>((resolve, reject) => {
      const c = connect(sock);
      let buf = '';
      c.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n')) { c.destroy(); resolve(buf); }
      });
      c.on('connect', () => c.write('not-json\n'));
      c.on('error', reject);
    });
    const parsed = JSON.parse(result.trim()) as { ok: boolean; error: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Invalid JSON/);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
