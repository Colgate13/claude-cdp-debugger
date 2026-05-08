#!/usr/bin/env node
// Lightweight doc-coverage report for src/lib/.
// Counts top-level exported declarations and how many have a JSDoc block (/** */)
// directly above them. Writes a JSON summary, prints a human-readable report,
// and exits non-zero when coverage falls below the threshold.

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const ROOT = join(REPO, 'src', 'lib');
const REPORT_DIR = join(REPO, 'quality-reports');
const REPORT_FILE = join(REPORT_DIR, 'doc-coverage.json');
const THRESHOLD = Number(process.env.DOC_COVERAGE_THRESHOLD ?? 50);

// Match top-level exported declarations.
const DECL_RE = /^export\s+(?:default\s+|abstract\s+|async\s+)*(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/;

function listTsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function hasJsdocAbove(lines, idx) {
  // Walk backwards over blank lines, decorators, eslint comments. Look for `*/` close.
  let i = idx - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//')) { i--; continue; }
    return t.endsWith('*/');
  }
  return false;
}

const perFile = [];
let total = 0;
let documented = 0;
const undocumented = [];

for (const file of listTsFiles(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let fileTotal = 0;
  let fileDocumented = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_RE.exec(lines[i]);
    if (!m) continue;
    fileTotal++;
    total++;
    if (hasJsdocAbove(lines, i)) {
      fileDocumented++;
      documented++;
    } else {
      undocumented.push({ file: file.replace(REPO + '/', ''), line: i + 1, name: m[1] });
    }
  }
  if (fileTotal > 0) {
    perFile.push({
      file: file.replace(REPO + '/', ''),
      exports: fileTotal,
      documented: fileDocumented,
      coverage: fileTotal === 0 ? 1 : fileDocumented / fileTotal,
    });
  }
}

const coverage = total === 0 ? 1 : documented / total;
const summary = {
  threshold: THRESHOLD / 100,
  coverage,
  total,
  documented,
  undocumented: undocumented.length,
  perFile,
  passed: coverage >= THRESHOLD / 100,
  undocumentedSymbols: undocumented,
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(REPORT_FILE, JSON.stringify(summary, null, 2));

const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log(`\nDocumentation coverage (src/lib/): ${pct(coverage)} (${documented}/${total} exports)\n`);
console.log('Per file:');
for (const f of perFile) {
  const mark = f.coverage >= 0.5 ? '✓' : '✗';
  console.log(`  ${mark}  ${f.file}: ${pct(f.coverage)}  (${f.documented}/${f.exports})`);
}
if (undocumented.length > 0) {
  console.log(`\nUndocumented symbols (top 10):`);
  for (const u of undocumented.slice(0, 10)) {
    console.log(`  - ${u.file}:${u.line}  ${u.name}`);
  }
  if (undocumented.length > 10) console.log(`  ... +${undocumented.length - 10} more`);
}
console.log(`\nThreshold: ${pct(THRESHOLD / 100)}`);
console.log(summary.passed ? '✓ PASSED' : '✗ FAILED');
console.log(`Report: ${REPORT_FILE.replace(REPO + '/', '')}`);

process.exit(summary.passed ? 0 : 1);
