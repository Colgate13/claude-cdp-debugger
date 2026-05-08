import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runCli } from '../lib/cli-main.js';
import { runDaemon } from '../lib/daemon-main.js';

// dist/cli.js → up one = dist/, up two = repo/skill root
const SELF_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = dirname(dirname(SELF_PATH));

const argv = process.argv.slice(2);

if (argv[0] === '__daemon') {
  await runDaemon(argv.slice(1));
} else {
  await runCli(argv, SELF_PATH, SKILL_ROOT);
}
