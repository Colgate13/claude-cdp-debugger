#!/usr/bin/env node
import { build } from 'esbuild';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outFile = join(root, 'dist', 'cli.js');

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(join(root, 'dist'), { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'bin', 'cdp.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: outFile,
  sourcemap: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __cdpCreateRequire } from 'node:module';",
      'const require = __cdpCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

chmodSync(outFile, 0o755);
console.log(`built ${outFile}`);
