---
name: debug
description: "Live-debug a running Node.js service via Chrome DevTools Protocol. Use this skill whenever the user says 'debug', 'set a breakpoint', 'investigate runtime', 'inspect at runtime', 'why is variable Y wrong', or asks to attach to a running container/process to step through real execution. Works on any Node.js project (NestJS, ts-node, plain Node, compiled to dist/) that has a `.vscode/launch.json` with an `attach` config — the skill discovers the inspector port, container name, and source-map setup automatically. The skill is conversational: Claude picks breakpoints from the request context, the user manipulates the system (curl/browser), the breakpoint hits, Claude reports findings, then resumes. Do NOT use this skill for: writing/running unit tests (use jest directly), static code review, log inspection (use docker logs)."
version: 0.1.0
---

# Debug Skill

A live debugger for Node.js services. Each project's `.vscode/launch.json` exposes a Node Inspector port; this skill connects via CDP, sets breakpoints, captures pause events, and lets Claude inspect runtime state — all without leaving the conversation.

## When to use

Triggers the user might say:
- "debug `UserService.create`"
- "set a breakpoint at `user.controller.ts:42`"
- "I want to see what arrives in `dto` when I POST"
- "investigate why this route returns 500"
- "trace the call when handler X runs"
- "logpoint on this line to see `user.id`"

Triggers that should NOT route here (use other tools):
- "run the unit tests" → jest
- "review this code" → code-reviewer agent
- "show me the container logs" → `docker logs`
- "explain how X works" → just read the code

## High-level workflow

1. **Pick breakpoints.** Read the code around the user's target. Choose 1–4 breakpoints at the most informative spots: function entry, before a critical branch, after an external call, near the suspicious return. Keep it tight — too many BPs = noise.
2. **Verify environment.** Run `<skill-root>/dist/bin/doctor.js` once per session if not run recently. It validates Node, deps, and `socat`/`curl --unix-socket`.
3. **Start daemon.** From the project's CWD, run `<skill-root>/dist/bin/debug.js start` with `run_in_background: true`. Use the Monitor tool to tail the daemon log.
4. **Wait for `connected` event** in the log. If the log says the container/inspector port is unreachable, the message includes the exact recovery command (e.g., `docker start <container>`).
5. **Set breakpoints.** `<skill-root>/dist/bin/debug.js bp set <file>:<line>` for each chosen point. Accept TS or JS paths — daemon handles source-map translation for compiled projects.
6. **Tell the user to act.** Short, specific: *"Ready. Trigger the POST /api/users and I'll watch."*
7. **Watch for `paused` events** via Monitor. Each event carries a frame summary + locals preview already fitted to the LLM budget (depth 2, ~8KB cap).
8. **Inspect.** Use `<skill-root>/dist/bin/debug.js eval <expr>` (or `locals`, `stack`) to dig into specific values. Eval works in both paused (call-frame) and running (Runtime.evaluate) states.
9. **Report findings** in the conversation in plain language — what's surprising, what matches expectation, what's the next hypothesis.
10. **Move forward** — `step over/in/out`, `resume`, or set new BPs based on what you saw.
11. **When understood, stop.** `<skill-root>/dist/bin/debug.js stop` clears BPs, disconnects, kills the daemon. Always stop before ending the conversation topic.

> The path `<skill-root>` resolves to wherever this skill is installed — typically `~/.claude/skills/debug/` (when installed as a Claude Code skill) or a clone of the repository.

## Reference: CLI commands

```
debug doctor                                    validate env, install deps if missing
debug start [--project <path>] [--reattach]     start daemon for current project
debug stop [--all]                              clean up daemon(s)
debug status                                    PID alive? attached? FSM state? BPs?
debug ls                                        list all live daemons across projects
debug tail                                      print path of event log file (use with Monitor)

debug bp set <file:line> [--cond <expr>] [--log <expr>]
debug bp list
debug bp rm <id|all>

debug wait [--timeout <sec>]                    block until next paused event; returns frame+locals
debug eval <expr> [--depth <N>] [--frame <N>]   evaluate expression
debug locals [--depth <N>]                      dump current frame locals
debug stack                                     summarized call stack

debug step over | in | out
debug resume
```

## Output format

All commands return JSON to stdout. Daemon events are written to `/tmp/claude-debug-<slug>.log` (one JSON object per line). Common event shapes:

```json
{"event":"connected","port":9229,"target":{"id":"...","title":"..."}}
{"event":"breakpoint-set","id":"bp-1","file":"user.service.ts","line":42}
{"event":"paused","reason":"breakpoint","bp":"bp-1","frame":{"function":"UserService.create","file":"user.service.ts","line":42},"locals":{...}}
{"event":"resumed"}
{"event":"logpoint","bp":"bp-2","value":"user=abc-123","ts":1234567890}
{"event":"detached","reason":"stop|crash|idle"}
```

Eval results:
```json
{"ok":true,"value":{...formatted...}}
{"ok":false,"error":"...","state":"running"}
```

## Output budget rules (followed by daemon)

- Default depth: 2 levels of object expansion
- Max 50 properties per object level
- Strings truncated at 200 chars (`...[truncated +N chars]`)
- Arrays truncated at 10 items (`...(+N more)`)
- Total payload cap: 8KB per command response
- Circular references shown as `[Circular: <path>]`
- Mongoose-like documents: prefer `.toObject()` if available

## Patterns Claude should follow

**Choosing breakpoints.** Don't carpet-bomb. For "why is X wrong", set BP at the moment X is *decided* (assignment line, return statement, condition branch), not at every line of the function. For "what payload arrives", BP on the first executable line of the controller method.

**Reporting back.** When a paused event arrives, summarize it for the user in plain language: *"Hit `user.service.ts:42`. `dto.email = '...'`, `existing.id = null`. The create path is taken — looks expected so far."* — then suggest the next step.

**Logpoints over breakpoints when possible.** If the user wants to *observe* multiple events without pausing the request flow, use `bp set --log <expr>`. Doesn't pause the process. Useful for high-frequency code paths.

**Cleanup discipline.** Always call `debug stop` when the investigation ends or the user's topic shifts. Orphan daemons hold inspector connections and consume resources. Use `debug ls` if you suspect stale ones from a previous session.

**Multi-project.** If debugging an inter-service call (e.g., service A → service B), start a daemon per project in parallel. Each has its own socket+log+pid by slug.

## Bootstrap on first use

If `node_modules/chrome-remote-interface/package.json` is missing under the skill root, the CLI auto-installs deps with `npm i --omit=dev --prefix <skill-root>`. Should take ~5 seconds. No native builds.

## Failure modes the daemon handles

- **Container not running**: error includes exact `docker start <container>` from tasks.json
- **Inspector port not listening**: error after 5s timeout retrying connection
- **Source map missing for compiled project**: falls back to BP on parallel `dist/.../foo.js` with the SAME line number. **Caveat**: TS line ≠ JS line in compiled files (JS adds boilerplate, decorators, etc.). When this happens, the daemon emits a `sourcemap-fallback` event with a warning. If a BP doesn't fire when expected, set the BP directly on the `.js` file at the correct line — use `dist/src/.../foo.js:N` instead of `src/.../foo.ts:N`.
- **Process restart while attached**: WS UUID changes; daemon detects and emits `detached` with reason; CLI tells user to `debug start --reattach`
- **Unsupported command in current FSM state**: rejected with explicit message ("eval requires paused state; current=running")
- **Inspector script URL doesn't match BP URL**: CDP returns `locations: []` (BP pending). The script may not be loaded yet, or the URL pattern is wrong. Check `bp list` — `locations: 0` means pending.

## Notes on real-world BP firing

- BP fires only when the actual line of bound `.js` runs. In compiled projects without source maps, the parallel-path fallback uses the same line number, which is approximate. **Tip**: open the `.js` file under `dist/` and find the executable line that corresponds to the TS code you want to inspect.
- BP setting is async with respect to script loading. If the file isn't loaded yet, BP is "pending" — it'll bind when the script first loads.
- For projects using ts-node directly (`runtime: ts-node`), `.ts` paths work directly because Node's ts-node loader registers `.ts` URLs with the inspector. No source-map work needed.

## Architecture quick ref

- **Daemon** (`<skill-root>/dist/bin/debug-daemon.js`) — long-running background process per project; connects CDP, listens on Unix socket
- **CLI** (`<skill-root>/dist/bin/debug.js`) — invoked from Bash; talks to daemon via socket; auto-detects project via CWD walking up
- **Handlers** (`src/lib/handlers-bp.ts`, `src/lib/handlers-inspect.ts`) — register BP and inspect commands on the `DaemonContext` instance
- **Files per session**:
  - `/tmp/claude-debug-<slug>.sock` — IPC
  - `/tmp/claude-debug-<slug>.log` — structured event stream
  - `/tmp/claude-debug-<slug>.daemon.log` — daemon stdout/stderr (crash output)
  - `/tmp/claude-debug-<slug>.pid` — PID file for crash detection
  - `/tmp/claude-debug-<slug>.bps.json` — persisted BPs for `--reattach`

## When in doubt

Run `debug status` to see exactly what the daemon thinks. Run `debug doctor` if anything seems off about the environment. Read the event log directly with `cat $(debug tail)`.
