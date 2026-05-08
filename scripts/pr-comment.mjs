#!/usr/bin/env node
// Builds the PR-comment body from quality-reports/summary.md, appending
// collapsible <details> blocks with the tail of each failed step's log.
// Output goes to stdout (the workflow redirects to a file).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS = join(ROOT, 'quality-reports');

const heading = process.env.PR_COMMENT_HEADING ?? 'Quality Gate';
const summary = readFileSync(join(REPORTS, 'summary.md'), 'utf8');
const summaryJson = JSON.parse(readFileSync(join(REPORTS, 'summary.json'), 'utf8'));

const MAX_LOG_LINES = 80;
const MAX_LOG_CHARS = 6000;

let out = summary
  .replace(/^# Quality Gate Report/, `# ${heading}`)
  // Drop the "## Artifacts" file-listing section — those local paths aren't
  // clickable from a PR comment; the workflow artifact upload covers it.
  .replace(/\n## Artifacts\n[\s\S]*?(?=\n## |\n*$)/, '');

const failed = (summaryJson.steps ?? []).filter((s) => !s.ok);
if (failed.length > 0) {
  out += '\n\n## Failure logs (tail)\n';
  for (const step of failed) {
    const artifact = step.artifact ?? `${step.name}.log`;
    const logPath = join(REPORTS, artifact);
    if (!existsSync(logPath)) {
      out += `\n_${step.name}: no log available at \`${artifact}\`._\n`;
      continue;
    }
    const raw = readFileSync(logPath, 'utf8');
    const tail = raw.split('\n').slice(-MAX_LOG_LINES).join('\n').slice(-MAX_LOG_CHARS);
    out += `\n<details><summary><code>${step.name}</code> — ${step.summary ?? 'failed'}</summary>\n\n\`\`\`\n${tail}\n\`\`\`\n\n</details>\n`;
  }
}

process.stdout.write(out);
