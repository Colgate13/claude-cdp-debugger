#!/usr/bin/env node
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, '..', 'dist', 'bin');

for (const f of readdirSync(binDir)) {
  if (!f.endsWith('.js')) continue;
  const p = join(binDir, f);
  if (!statSync(p).isFile()) continue;
  chmodSync(p, 0o755);
}
console.log('post-build: chmod +x dist/bin/*.js done');
