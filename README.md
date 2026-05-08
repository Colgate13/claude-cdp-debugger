# claude-cdp-debugger

A [Claude Code](https://claude.com/claude-code) skill that lets the agent **live-debug any Node.js service** via the Chrome DevTools Protocol — auto-discovers `.vscode/launch.json`, sets breakpoints, captures pauses, inspects runtime state, and reports back conversationally.

> **TL;DR.** You say *"debug `UserService.create`"* → Claude reads the code, picks breakpoints, attaches to your already-running container, waits for the breakpoint to hit, inspects variables, and tells you what it sees in plain language. You drive the request flow (curl/browser); Claude does the inspection.

## What it does

- **Auto-discovers project config** from `.vscode/launch.json` (`attach` config) + `.vscode/tasks.json` (Docker container name). No per-project config.
- **Survives across tool calls.** A long-lived background daemon keeps the CDP WebSocket open while the CLI client (used by Claude via Bash) issues stateless commands.
- **Source-map aware.** TypeScript line numbers translate to compiled `.js` when source maps exist; falls back to a parallel-path heuristic when they don't.
- **Conversational pause flow.** Pause events are streamed to a structured event log (`/tmp/claude-debug-<slug>.log`); Claude tails it via the Monitor tool and reacts in real time.
- **LLM-friendly output.** Variable dumps are auto-formatted: depth-limited (default 2), array-truncated, circular-ref aware, with a hard 8KB payload cap.
- **Logpoints.** Capture an expression on every hit without pausing the process.
- **Multi-session.** Debug several services simultaneously (e.g., upstream + downstream of an inter-service call).
- **Crash recovery.** If the daemon dies, persisted breakpoints reattach with `debug start --reattach`.

## Requirements

- Node.js **22+** on the host
- A Node.js service started with `--inspect` or `--inspect-brk` (works with NestJS `--debug`, ts-node, or compiled `dist/`)
- A `.vscode/launch.json` with an `attach` config (the standard VSCode Node debug pattern)
- Either `socat` or `curl --unix-socket` (the latter ships with most curl builds)

## Install

### As a Claude Code plugin (preferred, once published to a marketplace)

```bash
/plugin install claude-cdp-debugger
```

### Direct install from this repo

For now, clone and run the installer. It copies (or symlinks) the skill into `~/.claude/skills/debug/`:

```bash
git clone https://github.com/Colgate13/claude-cdp-debugger.git ~/projects/claude-cdp-debugger
cd ~/projects/claude-cdp-debugger
npm install --omit=dev
bash bin/install.sh   # symlinks ~/.claude/skills/debug -> this clone (good for development)
```

After install, Claude Code picks up the skill automatically. Trigger it with `/debug` or natural language ("debug X", "set a breakpoint at...", "investigate why...").

### Standalone CLI usage (without Claude Code)

The bins also work outside of Claude Code. After cloning + `npm install`:

```bash
node ~/projects/claude-cdp-debugger/bin/debug.mjs doctor
node ~/projects/claude-cdp-debugger/bin/debug.mjs start
node ~/projects/claude-cdp-debugger/bin/debug.mjs bp set src/user.controller.ts:42
# ... trigger your code path ...
node ~/projects/claude-cdp-debugger/bin/debug.mjs wait
node ~/projects/claude-cdp-debugger/bin/debug.mjs eval "dto"
node ~/projects/claude-cdp-debugger/bin/debug.mjs resume
node ~/projects/claude-cdp-debugger/bin/debug.mjs stop
```

(Add `~/projects/claude-cdp-debugger/bin` to your `PATH` to drop the `node ... bin/debug.mjs` prefix.)

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
   bin/debug.mjs ──── Unix socket ──→ bin/debug-daemon.mjs (per project, long-lived)
                                           │
                                           ▼ Chrome DevTools Protocol (WebSocket)
                                      Node Inspector (your service, in container or locally)
```

- **Daemon** (`bin/debug-daemon.mjs`) holds the CDP WebSocket connection, manages breakpoints, serializes commands through a small FSM (`idle | running | paused | stepping`), and writes structured events to a log file with `fsync`-on-write.
- **CLI** (`bin/debug.mjs`) is stateless — each invocation opens a Unix socket to the daemon, sends one command, prints the JSON response, exits.
- **Library code** (`lib/`) is split into small modules: `detect`, `cdp`, `ipc`, `events`, `state`, `format`, `sourcemap`, `handlers-bp`, `handlers-inspect`.

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

## Contributing

PRs welcome. The code is small (~2k lines, no build step) and explicitly factored to make adding handlers easy:

- New CLI command? Add a `case` in `bin/debug.mjs` and a handler in `lib/handlers-*.mjs`.
- New domain formatter (e.g., Prisma model)? Extend `lib/format.mjs`'s `formatObject` switch on `subtype`.

Run `node bin/doctor.mjs` after changes to validate the environment.

## License

MIT — see [LICENSE](LICENSE).
