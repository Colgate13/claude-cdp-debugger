#!/usr/bin/env bash
# Installs claude-cdp-debugger as a Claude Code skill at ~/.claude/skills/debug
# by symlinking this clone, so editing the repo updates the skill instantly.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( dirname "$SCRIPT_DIR" )"
TARGET="${HOME}/.claude/skills/debug"

mkdir -p "${HOME}/.claude/skills"

if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  echo "Existing entry at $TARGET — refusing to overwrite."
  echo "If you want to replace it, remove it first:"
  echo "  rm -rf $TARGET"
  exit 1
fi

# Install dependencies (including devDeps so we can build) and compile TypeScript → dist/
echo "Installing dependencies and building..."
npm install --prefix "$REPO_ROOT" --loglevel=error
npm run --prefix "$REPO_ROOT" build

ln -s "$REPO_ROOT" "$TARGET"
echo "Linked $TARGET -> $REPO_ROOT"

node "$REPO_ROOT/dist/bin/doctor.js" || true

echo ""
echo "Skill installed. Trigger it in Claude Code with /debug or natural language ('debug X')."
