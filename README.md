# claude-cdp-debugger

A [Claude Code](https://claude.com/claude-code) skill for live-debugging Node.js services over the Chrome DevTools Protocol.

You say *"debug `UserService.create`"* → Claude reads the code, picks breakpoints, attaches to your running process, waits for a hit, inspects variables, and reports back in plain language. You drive the request (curl/browser); Claude does the inspection.

## What it does

- **Zero per-project config** — discovers the inspector port and (optional) container name from `.vscode/launch.json` + `tasks.json`.
- **Source-map aware** — set breakpoints in `.ts`, hits the correct line in compiled `.js`.
- **LLM-friendly variable dumps** — depth-limited, array-truncated, circular-ref aware, capped at 8 KB per response.
- **Logpoints** — capture an expression on every hit without pausing the process.
- **Multi-session** — debug several services in parallel (e.g. upstream + downstream of a call).
- **Crash recovery** — `debug start --reattach` reapplies persisted breakpoints if the daemon dies.

## Requirements

- Node.js **22+** on the host
- A Node.js service started with `--inspect` or `--inspect-brk` (works with NestJS `--debug`, ts-node, or compiled `dist/`)
- A `.vscode/launch.json` with an `attach` config (the standard VSCode Node debug pattern)
- Either `socat` or `curl --unix-socket` (the latter ships with most curl builds)

## Install

> **Distribution status.** A Claude Code plugin marketplace manifest is not yet published for this repo, so a single-line `/plugin install …` does **not** work today. The manual install below is the supported path. Once a marketplace manifest lands here, the two-step plugin flow (also documented below) will work.

### Manual install — works today

Clone the repo and run the installer. It runs `npm install && npm run build`, then symlinks the skill into `~/.claude/skills/debug/`, so editing the clone updates the skill instantly:

```bash
git clone https://github.com/Colgate13/claude-cdp-debugger.git ~/projects/claude-cdp-debugger
cd ~/projects/claude-cdp-debugger
bash bin/install.sh
```

Claude Code picks up the skill automatically on next start. Trigger it with `/debug` or natural language ("debug X", "set a breakpoint at...", "investigate why...").

To uninstall: `rm ~/.claude/skills/debug` (it's a symlink — removing it does not delete the clone).

### As a Claude Code plugin — once a marketplace manifest is added

Claude Code's plugin system is a **two-step flow**: register the marketplace first, then install plugins from it. There is **no** shortcut that installs a plugin from an unregistered third-party repo in one command.

```text
/plugin marketplace add Colgate13/claude-cdp-debugger
/plugin install claude-cdp-debugger@<marketplace-name>
```

- `Colgate13/claude-cdp-debugger` is the GitHub `owner/repo` (an HTTPS URL or `…#branch` ref also works).
- `<marketplace-name>` is the `name` field from `.claude-plugin/marketplace.json` in this repo, which the marketplace exposes after the `marketplace add` step.

This path is gated on the repo gaining a `.claude-plugin/marketplace.json` (tracked separately). Until then, prefer the manual install above.

Requires a Claude Code build with the plugin system (`/plugin` available — run `claude --version` to check, and update if `/plugin` is unrecognized).

## CLI reference

```
debug doctor                                    validate env, install deps if missing
debug start [--project <path>] [--reattach]     start daemon for current project
debug stop [--all]                              clean up daemon(s)
debug status                                    PID alive? attached? FSM state? BPs?
debug ls                                        list all live daemons across projects
debug tail                                      print path of event log (use with `tail -F`)

debug bp set <file:line> [--cond <expr>] [--log <expr>]
debug bp list
debug bp rm <id|all>

debug wait [--timeout <sec>]                    block until next paused event
debug eval <expr> [--depth <N>] [--frame <N>]   evaluate expression
debug locals [--depth <N>]                      dump current frame locals
debug stack                                     summarized call stack

debug step over | in | out
debug resume
```

All commands return JSON to stdout. Daemon events are written line-by-line to `/tmp/claude-debug-<slug>.log`.

## How Claude uses it

1. Reads the source around the user's target (`/src/user.service.ts` etc.)
2. Picks 1–4 strategic breakpoints — function entry, critical branches, suspicious returns
3. Spawns the daemon in background; tails its event log via the Monitor tool
4. Tells the user: *"Ready — trigger the request"*
5. When `paused` events arrive, runs `eval`, `locals`, `stack` to gather context
6. Reports findings in the chat in plain language, suggests next steps
7. Steps, resumes, or sets new breakpoints based on what was found
8. Calls `debug stop` when the investigation is over

## Architecture

```
┌─────────────────────────────────────────┐
│  Claude (via Bash + Monitor tools)      │
└──────┬──────────────────────────┬───────┘
       │ stateless CLI commands   │ tail -F event log
       ▼                          ▼
   dist/bin/debug.js ─── Unix socket ──→ dist/bin/debug-daemon.js (per project, long-lived)
                                           │
                                           ▼ Chrome DevTools Protocol (WebSocket)
                                      Node Inspector (your service, in container or locally)
```

- **Daemon** (`src/bin/debug-daemon.ts` → `dist/bin/debug-daemon.js`) holds the CDP WebSocket connection, manages breakpoints, serializes commands through a small FSM (`idle | running | paused | stepping`), and writes structured events to a log file with `fsync`-on-write.
- **CLI** (`src/bin/debug.ts` → `dist/bin/debug.js`) is stateless — each invocation opens a Unix socket to the daemon, sends one command, prints the JSON response, exits.
- **Library code** (`src/lib/`) is split into small TypeScript modules: `types`, `daemon-context`, `detect`, `cdp`, `ipc`, `events`, `state`, `format`, `sourcemap`, `handlers-bp`, `handlers-inspect`.

## Standalone CLI usage (without Claude Code)

The bins also work outside of Claude Code. After cloning + `npm install && npm run build`:

```bash
node ~/projects/claude-cdp-debugger/dist/bin/debug.js doctor
node ~/projects/claude-cdp-debugger/dist/bin/debug.js start
node ~/projects/claude-cdp-debugger/dist/bin/debug.js bp set src/user.controller.ts:42
# ... trigger your code path ...
node ~/projects/claude-cdp-debugger/dist/bin/debug.js wait
node ~/projects/claude-cdp-debugger/dist/bin/debug.js eval "dto"
node ~/projects/claude-cdp-debugger/dist/bin/debug.js resume
node ~/projects/claude-cdp-debugger/dist/bin/debug.js stop
```

(Add `~/projects/claude-cdp-debugger/dist/bin` to your `PATH` to drop the `node ... debug.js` prefix.)

## Files per session

| Path | Purpose |
|------|---------|
| `/tmp/claude-debug-<slug>.sock` | Unix socket for CLI ↔ daemon IPC |
| `/tmp/claude-debug-<slug>.log` | Append-only structured event stream |
| `/tmp/claude-debug-<slug>.daemon.log` | Daemon stdout/stderr (crash diagnostic) |
| `/tmp/claude-debug-<slug>.pid` | PID file for crash detection |
| `/tmp/claude-debug-<slug>.bps.json` | Persisted breakpoints (for `--reattach`) |

`<slug>` is derived from the project root directory name.

## Output budget (LLM-friendly formatting)

When inspecting variables, the daemon applies these caps so paused-frame dumps fit comfortably in an LLM context:

- Depth: 2 levels of object expansion
- Max 50 properties per object level
- Strings truncated at 200 chars (`...[truncated +N chars]`)
- Arrays truncated at 10 items (`...(+N more)`)
- Total payload cap: 8KB per command response
- Circular references: shown as `[Circular]`
- Mongoose-like documents: prefer `.toObject()` if available
- Promises: shown as `{ __promise: { state, value } }`

Need more? `debug eval foo.bar.specific.path --depth 4` to dive into a specific subtree.

## Troubleshooting

**"Container not running"** — the error includes the exact `docker start <name>` to run.

**"Inspector port not listening"** — start your Node process with `--inspect=0.0.0.0:<port>` (or `--inspect-brk` if you want to pause at startup).

**Breakpoint sets but never fires** — likely a source-map mismatch. If your project compiles to `dist/` without source maps, the line you set in `.ts` may not correspond to the same line in `.js`. Open `dist/.../foo.js`, find the right executable line, and set the BP directly there.

**`debug ls` shows daemons that don't respond** — orphan from a previous crash. Run `debug stop --all` to clean up `/tmp/claude-debug-*` files.

**`require is not defined` in eval** — `Runtime.evaluate` runs in a fresh V8 context without CommonJS. Access values via `globalThis` or evaluate inside a paused frame.

## Limitations

- Node.js only (no Python/Java/Ruby — would need DAP/JDWP support)
- Source-map fallback for compiled projects without `.js.map` is approximate (same line in TS and JS rarely line up exactly)
- Single CDP target per port — if your process forks workers, you can only attach to one
- No time-travel debugging (Node has no native support)

## License

MIT — see [LICENSE](LICENSE).
