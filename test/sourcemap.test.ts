import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { SourceMapResolver } from '../src/lib/sourcemap.js';

// Hand-crafted minimal source map: a single TS line maps to a single JS line.
// Format: VLQ for { genCol, sourceIdx, origLine, origCol }.
//
// VLQ encoding: groups of 5 bits, MSB=continuation. To map line 1 → line 1
// of source 0, we need a token at gen col 0 → src 0, line 0 (zero-based), col 0.
// Encoded as 'AAAA'. Multi-line (gen line) separation is ';'.

function buildFixture(root: string): { tsPath: string; jsPath: string } {
  const srcDir = join(root, 'src');
  const distDir = join(root, 'dist', 'src');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  const tsPath = join(srcDir, 'foo.ts');
  const jsPath = join(distDir, 'foo.js');
  writeFileSync(tsPath, 'export const x = 1;\nexport const y = 2;\n');
  writeFileSync(jsPath, 'exports.x = 1;\nexports.y = 2;\n//# sourceMappingURL=foo.js.map\n');

  // Build source map mapping line 1→1, line 2→2.
  const map = {
    version: 3,
    file: 'foo.js',
    sources: ['../../src/foo.ts'],
    sourcesContent: ['export const x = 1;\nexport const y = 2;\n'],
    names: [],
    mappings: 'AAAA;AACA',
  };
  writeFileSync(jsPath + '.map', JSON.stringify(map));
  return { tsPath, jsPath };
}

test('candidateJsPaths: returns dist/src/<rel>.js path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cdp-sm-test-'));
  try {
    const tsPath = join(tmp, 'src', 'foo.ts');
    const r = new SourceMapResolver({ projectRoot: tmp });
    const candidates = r.candidateJsPaths(tsPath);
    assert.ok(candidates.some((c) => c.endsWith(join('dist', 'src', 'foo.js'))));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('tsToJs: returns null when no .js.map exists', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cdp-sm-test-'));
  try {
    const r = new SourceMapResolver({ projectRoot: tmp });
    const result = await r.tsToJs(join(tmp, 'src', 'missing.ts'), 1);
    assert.equal(result, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('tsToJs + jsToTs: round-trip through real source-map fixture', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cdp-sm-test-'));
  try {
    const { tsPath, jsPath } = buildFixture(tmp);
    const r = new SourceMapResolver({ projectRoot: tmp });

    const fwd = await r.tsToJs(tsPath, 1);
    assert.ok(fwd, 'tsToJs should resolve');
    assert.equal(fwd.jsPath, jsPath);
    assert.equal(fwd.jsLine, 1);

    const back = await r.jsToTs(jsPath, 1);
    assert.ok(back, 'jsToTs should resolve');
    assert.equal(back.tsLine, 1);

    r.destroy();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('tsToJs: caches result for repeated lookups', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cdp-sm-test-'));
  try {
    const { tsPath } = buildFixture(tmp);
    const r = new SourceMapResolver({ projectRoot: tmp });
    const a = await r.tsToJs(tsPath, 1);
    const b = await r.tsToJs(tsPath, 1);
    assert.deepEqual(a, b);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
