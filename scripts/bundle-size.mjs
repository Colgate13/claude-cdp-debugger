#!/usr/bin/env node
// Reports the size of dist/ (excluding sourcemaps) and asserts a threshold.

import { readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO, 'dist');
const REPORT_DIR = join(REPO, 'quality-reports');
const REPORT_FILE = join(REPORT_DIR, 'bundle-size.json');
// Pure JS payload threshold (.js files only). Sourcemaps excluded.
// Bundled output includes runtime deps (chrome-remote-interface, source-map);
// 1500KB leaves room for incidental growth without masking real regressions.
const THRESHOLD_KB = Number(process.env.BUNDLE_SIZE_THRESHOLD_KB ?? 1500);

if (!existsSync(DIST)) {
  console.error(`dist/ does not exist — run \`npm run build\` first.`);
  process.exit(1);
}

function walk(dir) {
  const entries = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) entries.push(...walk(p));
    else if (e.isFile()) entries.push({ path: p, size: statSync(p).size });
  }
  return entries;
}

const all = walk(DIST);
const jsFiles = all.filter((f) => f.path.endsWith('.js'));
const mapFiles = all.filter((f) => f.path.endsWith('.js.map'));

const totalJs = jsFiles.reduce((a, f) => a + f.size, 0);
const totalMap = mapFiles.reduce((a, f) => a + f.size, 0);
const total = all.reduce((a, f) => a + f.size, 0);

const summary = {
  threshold_kb: THRESHOLD_KB,
  totalKb: +(total / 1024).toFixed(1),
  jsKb: +(totalJs / 1024).toFixed(1),
  mapKb: +(totalMap / 1024).toFixed(1),
  files: jsFiles
    .map((f) => ({ file: f.path.replace(REPO + '/', ''), kb: +(f.size / 1024).toFixed(1) }))
    .sort((a, b) => b.kb - a.kb),
  passed: totalJs / 1024 < THRESHOLD_KB,
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(REPORT_FILE, JSON.stringify(summary, null, 2));

console.log(`\nBundle size (dist/):`);
console.log(`  Total:   ${summary.totalKb} KB`);
console.log(`  JS:      ${summary.jsKb} KB  (threshold: ${THRESHOLD_KB} KB)`);
console.log(`  Maps:    ${summary.mapKb} KB`);
console.log(`\nLargest .js files:`);
for (const f of summary.files.slice(0, 10)) {
  console.log(`  ${f.kb.toFixed(1).padStart(6)} KB  ${f.file}`);
}
console.log(`\n${summary.passed ? '✓ PASSED' : '✗ FAILED'}`);
console.log(`Report: ${REPORT_FILE.replace(REPO + '/', '')}`);

process.exit(summary.passed ? 0 : 1);
