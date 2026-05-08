# Troubleshooting — runtime

For install-time issues, see [INSTALL.md](INSTALL.md). This page covers errors you may hit while actually debugging code.

## Common errors

**"Container not running"** — The error includes the exact `docker start <name>` to run.

**"Inspector port not listening"** — Start your Node process with `--inspect=0.0.0.0:<port>` (or `--inspect-brk` to pause at startup).

**Breakpoint sets but never fires** — Likely a source-map mismatch. If your project compiles to `dist/` without source maps, the line you set in `.ts` may not correspond to the same line in `.js`. Open `dist/.../foo.js`, find the right executable line, and set the BP directly there.

**`cdp ls` shows daemons that don't respond** — Orphan from a previous crash. Run `cdp stop --all` to clean up `/tmp/claude-debug-*` files.

**`require is not defined` in eval** — `Runtime.evaluate` runs in a fresh V8 context without CommonJS. Access values via `globalThis` or evaluate inside a paused frame.

**"detached" event right after connect** — The target process restarted (e.g., nodemon reloaded). The WebSocket UUID changed. Run `cdp start --reattach` to re-attach and reapply persisted breakpoints.

**Eval rejected with "requires paused state"** — Some commands (`locals`, `stack`, `step`) only work when the process is paused at a breakpoint. Use `cdp wait` to block until the next pause, then run the inspect command.

**BP listed with `locations: 0`** — The script isn't loaded yet, or the URL pattern doesn't match. Trigger the code path that loads the script; `locations` should populate. Check `cdp bp list` to confirm.

## Output format budget (LLM-friendly formatting)

When inspecting variables, the daemon applies these caps so paused-frame dumps fit comfortably in an LLM context:

- Depth: 2 levels of object expansion (override with `--depth N`)
- Max 50 properties per object level
- Strings truncated at 200 chars (`...[truncated +N chars]`)
- Arrays truncated at 10 items (`...(+N more)`)
- Total payload cap: 8KB per command response
- Circular references shown as `[Circular: <path>]`
- Mongoose-like documents: prefer `.toObject()` if available
- Promises: shown as `{ __promise: { state, value } }`

Need more? `cdp eval foo.bar.specific.path --depth 4` to dive into a specific subtree.

## Files written during a session

| Path | Purpose |
|------|---------|
| `/tmp/claude-debug-<slug>.sock` | Unix socket for CLI ↔ daemon IPC |
| `/tmp/claude-debug-<slug>.log` | Append-only structured event stream |
| `/tmp/claude-debug-<slug>.daemon.log` | Daemon stdout/stderr (crash diagnostic) |
| `/tmp/claude-debug-<slug>.pid` | PID file for crash detection |
| `/tmp/claude-debug-<slug>.bps.json` | Persisted breakpoints (for `--reattach`) |

`<slug>` is derived from the project root directory name.

## When in doubt

- `cdp status` — what does the daemon think its state is?
- `cdp doctor` — environment sanity check
- `cat $(cdp tail | jq -r .log)` — read the raw event stream
- `cdp stop --all` — nuke every daemon and start fresh
