# Install — advanced

This page covers the dev install (hot-reload symlink), how the plugin install works under the hood, and what to do if `bin/install.sh` fails. For the regular install, see [README.md#install](README.md#install).

## Dev install — hot-reload symlink

If you plan to edit the skill or the CLI and want changes to take effect immediately (without re-running `/plugin install`), symlink the repo's `skills/cdp` directory into Claude Code's user-level skills folder:

```bash
git clone https://github.com/Colgate13/claude-cdp-debugger.git
cd claude-cdp-debugger
bash bin/install.sh                                        # builds dist/cli.js
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/cdp" ~/.claude/skills/cdp
```

Now editing `skills/cdp/SKILL.md` updates the skill on Claude Code's next start. Editing `src/**/*.ts` requires `npm run build` to regenerate `dist/cli.js`.

To uninstall: `rm ~/.claude/skills/cdp` (removes the symlink, not the clone).

## Standard install — what the two `/plugin` commands do

```text
/plugin marketplace add /absolute/path/to/claude-cdp-debugger
/plugin install claude-cdp-debugger@claude-cdp-debugger
```

- **`/plugin marketplace add <path>`** registers the local clone as a marketplace by reading `.claude-plugin/marketplace.json`. The marketplace's name is `claude-cdp-debugger` (the `name` field in that JSON).
- **`/plugin install <plugin>@<marketplace>`** installs the plugin defined in `.claude-plugin/plugin.json` from the registered marketplace. Both names happen to be `claude-cdp-debugger` here, hence the `@` repetition.

Once installed, Claude Code adds `bin/cdp` to the Bash tool's `PATH` and exposes `skills/cdp/SKILL.md` so the agent can route `/cdp`-style requests.

## What `bin/install.sh` does

1. `npm ci` — installs deps (production + dev, since esbuild needs to bundle).
2. `npm run build` — runs `scripts/build.mjs`, which uses esbuild to produce `dist/cli.js` (~1.2MB, all runtime deps inlined).
3. Prints the two `/plugin` commands you need to paste into Claude Code.

You can also build manually: `npm ci && npm run build`. The shim at `bin/cdp` falls back to running these on first invocation if `dist/cli.js` is missing.

## Standalone CLI (no Claude Code)

The bundled CLI works directly after `npm run build`:

```bash
./bin/cdp doctor              # validate env
./bin/cdp start               # start daemon for current project
./bin/cdp bp set src/foo.ts:42
./bin/cdp wait
./bin/cdp eval "someVariable"
./bin/cdp resume
./bin/cdp stop
```

Add `<repo>/bin` to your shell `PATH` to drop the `./` prefix.

## Common install issues

**`npm ci` fails with EACCES** — your global npm prefix needs sudo. Fix the prefix once: `npm config set prefix ~/.npm-global` then re-run `npm ci`.

**`npm run build` exits with esbuild errors** — typically a Node version mismatch. Confirm `node --version` is ≥ 22.

**`/plugin marketplace add` says "no marketplace.json found"** — you passed the wrong path. The argument must be the **absolute path** to the repo root (the directory containing `.claude-plugin/`), not a subdirectory.

**`/plugin install` can't find the plugin** — the marketplace name is `claude-cdp-debugger` (not the repo path). Use exactly: `/plugin install claude-cdp-debugger@claude-cdp-debugger`.

**Skill doesn't trigger on `/cdp`** — restart Claude Code after `/plugin install`. Plugins are loaded at session start.

**`bin/cdp` says "first run — building..." every time** — `dist/cli.js` is being deleted between runs (some test runners do this). Run `npm run build` once and leave the file in place.

## Uninstalling

```text
/plugin uninstall claude-cdp-debugger@claude-cdp-debugger
/plugin marketplace remove claude-cdp-debugger
```

Then optionally `rm -rf <clone>` to remove the source.
