#!/usr/bin/env bash
# Runs ESLint on the changed file, from the file's own workspace directory.
#
# The root eslint.config.js ignores apps/** and packages/** (each workspace
# owns its config), so running eslint from the repo root silently ignored
# every workspace file — a no-op that reported success. ESLint resolves its
# flat config from the CWD, so we cd into the workspace first.
#
# Diagnostics MUST go to stderr with exit 2 — that is the only channel the
# model sees. Stdout from PostToolUse hooks is discarded. Silent on success.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.tool_input?.file_path || '')")

# Skip if not a lintable file
if [[ ! "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi

# Convert absolute path to repo-relative
if [[ "$FILE_PATH" == "$REPO_ROOT/"* ]]; then
  RELATIVE="${FILE_PATH#$REPO_ROOT/}"
else
  RELATIVE="$FILE_PATH"
fi

# Detect the file's workspace (same detection as typecheck-changed.sh,
# generalized: every apps/* and packages/* workspace ships its own
# eslint.config.js). Files outside workspaces lint against the root config.
LINT_DIR="$REPO_ROOT"
if [[ "$RELATIVE" =~ ^(apps|packages)/([^/]+)/ ]]; then
  WORKSPACE_DIR="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  if [ -d "$REPO_ROOT/$WORKSPACE_DIR" ]; then
    LINT_DIR="$REPO_ROOT/$WORKSPACE_DIR"
  fi
fi

# Prefer the workspace-local eslint binary; fall back to the repo root's
# (config resolution follows the CWD, so the workspace config still applies).
ESLINT_BIN="$LINT_DIR/node_modules/.bin/eslint"
if [ ! -x "$ESLINT_BIN" ]; then
  ESLINT_BIN="$REPO_ROOT/node_modules/.bin/eslint"
fi
if [ ! -x "$ESLINT_BIN" ]; then
  exit 0 # eslint not installed — skip silently
fi

OUTPUT=$(cd "$LINT_DIR" && "$ESLINT_BIN" "$FILE_PATH" 2>&1)
STATUS=$?

if [ $STATUS -ne 0 ]; then
  {
    echo "❌ ESLint errors in $RELATIVE (fix before proceeding):"
    echo "$OUTPUT" | head -80
  } >&2
  exit 2
fi

# Guard against the silent no-op failure mode: a source file inside a
# workspace src/ tree must never be "ignored" — that means the wrong config
# was resolved and lint feedback is silently off.
if echo "$OUTPUT" | grep -q "File ignored" && [[ "$RELATIVE" =~ ^(apps|packages)/[^/]+/src/ ]]; then
  echo "⚠️ ESLint ignored source file $RELATIVE — lint feedback is broken for this file; check $WORKSPACE_DIR/eslint.config.js ignores" >&2
  exit 2
fi

exit 0
