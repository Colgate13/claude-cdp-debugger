# claude-cdp-debugger

A [Claude Code](https://claude.com/claude-code) plugin that lets the agent live-debug Node.js services. You say *"debug `UserService.create`"* — Claude reads the code, sets breakpoints, attaches over Chrome DevTools Protocol, watches for pauses, inspects state, and reports back in plain language. You drive the request (curl/browser); Claude does the inspection.

Works with any Node.js project that has a `.vscode/launch.json` attach config — NestJS, ts-node, plain Node, or compiled `dist/`. Source-map aware. Multi-session. Logpoints. Crash recovery via `--reattach`.

## Requirements

- Node.js **22+**
- A Node.js service started with `--inspect` (or `--inspect-brk`)
- A `.vscode/launch.json` with an `attach` configuration
- Either `socat` or `curl` with Unix socket support

## Install

```bash
git clone https://github.com/Colgate13/claude-cdp-debugger.git
cd claude-cdp-debugger
bash bin/install.sh
```

`install.sh` installs deps and builds the bundled CLI. When it finishes, it prints two commands to paste into Claude Code:

```text
/plugin marketplace add /absolute/path/to/claude-cdp-debugger
/plugin install claude-cdp-debugger@claude-cdp-debugger
```

Done. Trigger the skill with `/cdp` or natural language (`"debug X"`, `"set a breakpoint at..."`, `"investigate why..."`).

> **Need more?** [INSTALL.md](INSTALL.md) covers dev install (hot-reload symlink), troubleshooting the install itself, and standalone CLI usage. Runtime errors are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## CLI reference

```
cdp doctor                                    validate env
cdp start [--project <path>] [--reattach]     start daemon for current project
cdp stop [--all]                              clean up daemon(s)
cdp status                                    PID alive? attached? FSM state? BPs?
cdp ls                                        list all live daemons across projects
cdp tail                                      print path of event log

cdp bp set <file:line> [--cond <expr>] [--log <expr>]
cdp bp list
cdp bp rm <id|all>

cdp wait [--timeout <sec>]                    block until next paused event
cdp eval <expr> [--depth <N>] [--frame <N>]   evaluate expression
cdp locals [--depth <N>]                      dump current frame locals
cdp stack                                     summarized call stack

cdp step over | in | out
cdp resume
```

All commands return JSON to stdout. Daemon events are written line-by-line to `/tmp/claude-debug-<slug>.log`.

## How Claude uses it

1. Reads the source around the user's target (`/src/user.service.ts` etc.)
2. Picks 1–4 strategic breakpoints — function entry, critical branches, suspicious returns
3. Spawns the daemon in background; tails its event log via the Monitor tool
4. Tells the user: *"Ready — trigger the request"*
5. When `paused` events arrive, runs `cdp eval`, `cdp locals`, `cdp stack` to gather context
6. Reports findings in the chat in plain language, suggests next steps
7. Steps, resumes, or sets new breakpoints based on what was found
8. Calls `cdp stop` when the investigation is over

## Architecture

```
┌─────────────────────────────────────────┐
│  Claude (via Bash + Monitor tools)      │
└──────┬──────────────────────────┬───────┘
       │ stateless CLI commands   │ tail -F event log
       ▼                          ▼
   bin/cdp ── execs ──→ dist/cli.js ── Unix socket ──→ dist/cli.js __daemon (per project, long-lived)
                                                         │
                                                         ▼ Chrome DevTools Protocol (WebSocket)
                                                    Node Inspector (your service, in container or locally)
```

- **Single bundle** (`dist/cli.js`, ~1.2MB) holds CLI, daemon, and doctor; produced by esbuild from `src/lib/*.ts`.
- **Daemon mode** (`dist/cli.js __daemon …`) holds the CDP WebSocket connection, manages breakpoints, serializes commands through a small FSM (`idle | running | paused | stepping`), and writes structured events to a log file with `fsync`-on-write.
- **CLI mode** (`dist/cli.js …`) is stateless — each invocation opens a Unix socket to the daemon, sends one command, prints JSON, exits.
- **Library code** (`src/lib/`) is split into small TypeScript modules: `types`, `daemon-context`, `detect`, `cdp`, `ipc`, `events`, `state`, `format`, `sourcemap`, `handlers-bp`, `handlers-inspect`.

## Standalone CLI usage (without Claude Code)

After running `bash bin/install.sh`, the bundled CLI works directly:

```bash
./bin/cdp doctor
./bin/cdp start
./bin/cdp bp set src/user.controller.ts:42
# ... trigger your code path ...
./bin/cdp wait
./bin/cdp eval "dto"
./bin/cdp resume
./bin/cdp stop
```

(Add `<repo>/bin` to your `PATH` to drop the `./` prefix anywhere.)

## Limitations

- Node.js only (no Python/Java/Ruby — would need DAP/JDWP support)
- Source-map fallback for compiled projects without `.js.map` is approximate (same line in TS and JS rarely line up exactly)
- Single CDP target per port — if your process forks workers, you can only attach to one
- No time-travel debugging (Node has no native support)

## License

MIT — see [LICENSE](LICENSE).
