#!/usr/bin/env bash
# Local setup for claude-cdp-debugger.
# Installs deps, builds the bundled CLI, then prints the two Claude Code
# commands to register and install the plugin.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( dirname "$SCRIPT_DIR" )"

cd "$REPO_ROOT"

echo "→ installing dependencies (npm ci)..."
npm ci --loglevel=error

echo "→ building bundle..."
npm run build

echo ""
echo "✓ Setup complete. dist/cli.js is ready."
echo ""
echo "Next: register the plugin in Claude Code by running these two commands:"
echo ""
echo "  /plugin marketplace add $REPO_ROOT"
echo "  /plugin install claude-cdp-debugger@claude-cdp-debugger"
echo ""
echo "Then trigger the skill with /cdp or natural language ('debug X')."
