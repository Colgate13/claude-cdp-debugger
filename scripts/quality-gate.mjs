#!/usr/bin/env node
// Master quality gate. Runs every check, captures stdout+stderr to
// quality-reports/<step>.log, parses structured artifacts where available,
// prints a summary table, and exits non-zero if any check failed.
//
// Designed to be run both locally (`npm run quality`) and in CI (artifact
// upload of quality-reports/).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS = join(REPO, 'quality-reports');

// Fresh slate for every run so old artifacts don't mask new failures.
rmSync(REPORTS, { recursive: true, force: true });
mkdirSync(REPORTS, { recursive: true });

const CI = !!process.env.CI;
const STEPS = [];

function fmt(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function header(title) {
  const bar = '─'.repeat(Math.max(2, 60 - title.length));
  console.log(`\n┌─ ${title} ${bar}`);
}

function footer(ok, summary, ms) {
  const tag = ok ? '✓' : '✗';
  console.log(`└─ ${tag} ${summary} (${fmt(ms)})`);
}

function run(name, cmd, args, { artifact, env = {}, cwd = REPO } = {}) {
  header(name);
  const start = Date.now();
  const logFile = join(REPORTS, `${name}.log`);
  const res = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 50 * 1024 * 1024,
  });
  const out = (res.stdout ?? '') + (res.stderr ? `\n--- stderr ---\n${res.stderr}` : '');
  process.stdout.write(out);
  writeFileSync(logFile, out);
  const ms = Date.now() - start;
  const ok = res.status === 0;
  STEPS.push({ name, ok, ms, exitCode: res.status, artifact: artifact ?? null });
  return { ok, out, ms, exitCode: res.status };
}

// ─── Helpers to extract metrics from artifacts ──────────────────────────────

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function summarizeLint(out) {
  // ESLint stylish output ends with a "✖ N problems (X errors, Y warnings)" line.
  const m = /(\d+) errors?, (\d+) warnings?/.exec(out);
  if (m) return `${m[1]} errors, ${m[2]} warnings`;
  if (/^\s*$/.test(out.trim())) return '0 errors, 0 warnings';
  return 'see log';
}

function summarizeTests(out) {
  const tests = /^ℹ tests (\d+)/m.exec(out);
  const pass = /^ℹ pass (\d+)/m.exec(out);
  const fail = /^ℹ fail (\d+)/m.exec(out);
  if (tests && pass && fail) return `${pass[1]}/${tests[1]} passing, ${fail[1]} failing`;
  return 'see log';
}

function summarizeCoverage() {
  const sum = readJsonSafe(join(REPORTS, 'coverage', 'coverage-summary.json'));
  if (!sum) return 'see log';
  const total = sum.total ?? {};
  const fmt2 = (k) => total[k]?.pct != null ? `${total[k].pct.toFixed(0)}%` : '?';
  return `lines ${fmt2('lines')}, branches ${fmt2('branches')}, fns ${fmt2('functions')}`;
}

function summarizeDuplication() {
  const sum = readJsonSafe(join(REPORTS, 'duplication', 'jscpd-report.json'));
  if (!sum) return 'see log';
  const stats = sum.statistics?.total ?? {};
  return `${(stats.percentage ?? 0).toFixed(2)}% duplicated (${stats.clones ?? 0} clones, ${stats.duplicatedLines ?? 0} lines)`;
}

function summarizeDeadcode(out) {
  // knip reports "Unused files (N)", "Unused dependencies (N)", etc.
  const issues = [...out.matchAll(/Unused (\w+) \((\d+)\)/g)];
  if (issues.length === 0) return 'no issues';
  return issues.map((m) => `${m[2]} unused ${m[1]}`).join(', ');
}

function summarizeDocs() {
  const sum = readJsonSafe(join(REPORTS, 'doc-coverage.json'));
  if (!sum) return 'see log';
  const pct = (sum.coverage * 100).toFixed(1);
  return `${pct}% (${sum.documented}/${sum.total} exports)`;
}

function summarizeBundle() {
  const sum = readJsonSafe(join(REPORTS, 'bundle-size.json'));
  if (!sum) return 'see log';
  return `js ${sum.jsKb}KB / ${sum.threshold_kb}KB (total ${sum.totalKb}KB)`;
}

function summarizeAudit(out) {
  if (out.includes('found 0 vulnerabilities')) return '0 vulnerabilities';
  const m = /(\d+)\s+vulnerabilities?/i.exec(out);
  return m ? `${m[1]} vulnerabilities` : 'see log';
}

// ─── Run all checks ─────────────────────────────────────────────────────────

const lint = run('lint', 'npm', ['run', '--silent', 'lint'], { artifact: 'lint.log' });
STEPS.at(-1).summary = summarizeLint(lint.out);

const typecheck = run('typecheck', 'npm', ['run', '--silent', 'typecheck'], { artifact: 'typecheck.log' });
STEPS.at(-1).summary = typecheck.ok ? '0 errors' : `${(typecheck.out.match(/error TS/g) ?? []).length} errors`;

const typecheckTest = run('typecheck-test', 'npm', ['run', '--silent', 'typecheck:test'], { artifact: 'typecheck-test.log' });
STEPS.at(-1).summary = typecheckTest.ok ? '0 errors' : `${(typecheckTest.out.match(/error TS/g) ?? []).length} errors`;

const unit = run('test-unit', 'npm', ['run', '--silent', 'test:unit'], { artifact: 'test-unit.log' });
STEPS.at(-1).summary = summarizeTests(unit.out);

// Build is needed for both bundle-size, integration, doctor smoke.
const build = run('build', 'npm', ['run', '--silent', 'build'], { artifact: 'build.log' });
STEPS.at(-1).summary = build.ok ? 'ok' : 'failed';

const integration = build.ok
  ? run('test-integration', 'node', ['--test', '--test-timeout=60000', '--import', 'tsx', 'test-integration/cli-flow.test.ts'], { artifact: 'test-integration.log' })
  : { ok: false, out: 'skipped (build failed)', ms: 0 };
STEPS.at(-1).summary = build.ok ? summarizeTests(integration.out) : 'skipped';

const cov = run('coverage', 'npm', ['run', '--silent', 'coverage'], { artifact: 'coverage/' });
STEPS.at(-1).summary = summarizeCoverage();

const dup = run('duplication', 'npm', ['run', '--silent', 'duplication'], { artifact: 'duplication/' });
STEPS.at(-1).summary = summarizeDuplication();

const dead = run('deadcode', 'npm', ['run', '--silent', 'deadcode'], { artifact: 'deadcode.log' });
STEPS.at(-1).summary = summarizeDeadcode(dead.out);

const docs = run('docs', 'npm', ['run', '--silent', 'docs'], { artifact: 'docs/' });
STEPS.at(-1).summary = docs.ok ? 'docs/ generated' : 'failed';

const docCov = run('doc-coverage', 'node', ['scripts/doc-coverage.mjs'], { artifact: 'doc-coverage.json' });
STEPS.at(-1).summary = summarizeDocs();

const audit = run('audit', 'npm', ['audit', '--omit=dev', '--audit-level=high'], { artifact: 'audit.log' });
STEPS.at(-1).summary = summarizeAudit(audit.out);

const bundle = build.ok
  ? run('bundle-size', 'node', ['scripts/bundle-size.mjs'], { artifact: 'bundle-size.json' })
  : { ok: false, out: 'skipped (build failed)', ms: 0 };
STEPS.at(-1).summary = build.ok ? summarizeBundle() : 'skipped';

// ─── Final summary ──────────────────────────────────────────────────────────

const passed = STEPS.filter((s) => s.ok).length;
const failed = STEPS.length - passed;

const summaryMd = [
  '# Quality Gate Report',
  '',
  `**Result:** ${failed === 0 ? '✅ PASSED' : '❌ FAILED'}  (${passed}/${STEPS.length} checks)`,
  `**Date:** ${new Date().toISOString()}`,
  `**CI:** ${CI ? 'yes' : 'no'}`,
  '',
  '| Check | Status | Result | Time |',
  '|---|---|---|---|',
  ...STEPS.map((s) => `| ${s.name} | ${s.ok ? '✅' : '❌'} | ${s.summary ?? ''} | ${fmt(s.ms)} |`),
  '',
  '## Artifacts',
  '',
  ...STEPS.filter((s) => s.artifact).map((s) => `- \`quality-reports/${s.artifact}\` — ${s.name}`),
  '',
].join('\n');

writeFileSync(join(REPORTS, 'summary.md'), summaryMd);
writeFileSync(join(REPORTS, 'summary.json'), JSON.stringify({ passed: failed === 0, steps: STEPS }, null, 2));

console.log('\n\n══════════════════════════════════════════════════════════════');
console.log(`  Quality Gate ${failed === 0 ? '✅ PASSED' : '❌ FAILED'} — ${passed}/${STEPS.length} checks`);
console.log('══════════════════════════════════════════════════════════════');
const colWidths = [16, 4, 38, 8];
const pad = (s, w) => String(s).padEnd(w);
console.log(`  ${pad('check', colWidths[0])}${pad('', colWidths[1])}${pad('result', colWidths[2])}${pad('time', colWidths[3])}`);
console.log(`  ${'─'.repeat(colWidths.reduce((a, b) => a + b, 0))}`);
for (const s of STEPS) {
  const tag = s.ok ? '✓' : '✗';
  console.log(`  ${pad(s.name, colWidths[0])}${pad(tag, colWidths[1])}${pad(s.summary ?? '', colWidths[2])}${pad(fmt(s.ms), colWidths[3])}`);
}
console.log(`\n  Artifacts: ${REPORTS.replace(REPO + '/', '')}/`);
if (failed > 0) {
  console.log(`  Failed checks:`);
  for (const s of STEPS.filter((x) => !x.ok)) {
    console.log(`    - ${s.name}: ${s.summary ?? `exit ${s.exitCode}`} (see quality-reports/${s.name}.log)`);
  }
}
console.log('');

process.exit(failed === 0 ? 0 : 1);
