#!/usr/bin/env bash
# Runs TypeScript type checking on changed .ts/.tsx files
# Detects which app/package the file is in for the Turborepo monorepo

# Read JSON from stdin
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.tool_input?.file_path || '')")

# Skip if not a TypeScript file
if [[ ! "$FILE_PATH" =~ \.(ts|tsx)$ ]]; then
  exit 0
fi

# Convert absolute path to relative (strip repo root prefix)
REPO_ROOT=$(git rev-parse --show-toplevel)
if [[ "$FILE_PATH" == "$REPO_ROOT/"* ]]; then
  RELATIVE="${FILE_PATH#$REPO_ROOT/}"
else
  RELATIVE="$FILE_PATH"
fi

# Detect which workspace the file belongs to
if [[ "$RELATIVE" =~ ^apps/server/ ]]; then
  WORKSPACE_DIR="apps/server"
elif [[ "$RELATIVE" =~ ^apps/client/ ]]; then
  WORKSPACE_DIR="apps/client"
elif [[ "$RELATIVE" =~ ^apps/obsidian-plugin/ ]]; then
  WORKSPACE_DIR="apps/obsidian-plugin"
elif [[ "$RELATIVE" =~ ^apps/site/ ]]; then
  WORKSPACE_DIR="apps/site"
elif [[ "$RELATIVE" =~ ^apps/e2e/ ]]; then
  WORKSPACE_DIR="apps/e2e"
elif [[ "$RELATIVE" =~ ^packages/shared/ ]]; then
  WORKSPACE_DIR="packages/shared"
elif [[ "$RELATIVE" =~ ^packages/test-utils/ ]]; then
  WORKSPACE_DIR="packages/test-utils"
elif [[ "$RELATIVE" =~ ^packages/relay/ ]]; then
  WORKSPACE_DIR="packages/relay"
elif [[ "$RELATIVE" =~ ^packages/mesh/ ]]; then
  WORKSPACE_DIR="packages/mesh"
elif [[ "$RELATIVE" =~ ^packages/cli/ ]]; then
  # CLI uses esbuild bundling — tsc cannot resolve its cross-package imports at dev time
  echo "⏭️  Skipping typecheck for esbuild-bundled package (packages/cli)" >&2
  exit 0
else
  # Unknown package — skip silently to avoid false positives
  exit 0
fi

# Use the workspace-local tsc binary to avoid version mismatches
TSC_BIN="$REPO_ROOT/$WORKSPACE_DIR/node_modules/.bin/tsc"
if [ ! -x "$TSC_BIN" ]; then
  # Fall back to a parent node_modules if hoisted
  TSC_BIN=$(find "$REPO_ROOT/node_modules/.bin" -name tsc -type f 2>/dev/null | head -1)
fi

if [ -z "$TSC_BIN" ]; then
  echo "⏭️  tsc not found for $WORKSPACE_DIR — skipping" >&2
  exit 0
fi

# Incremental compilation: a per-workspace .tsbuildinfo makes warm re-checks
# ~1-3s instead of a 3-10s cold program build. The cache lives under the
# workspace's node_modules/.cache (gitignored via node_modules/ and the global
# *.tsbuildinfo pattern), so each worktree keeps its own cache.
CACHE_DIR="$REPO_ROOT/$WORKSPACE_DIR/node_modules/.cache"
mkdir -p "$CACHE_DIR" 2>/dev/null
BUILD_INFO="$CACHE_DIR/typecheck-hook.tsbuildinfo"

# Run TypeScript compiler from the workspace directory.
# Diagnostics MUST go to stderr with exit 2 — that is the only channel the
# model sees. Stdout from PostToolUse hooks is discarded. Silent on success.
DIAGNOSTICS=$(cd "$REPO_ROOT/$WORKSPACE_DIR" && "$TSC_BIN" --noEmit --project tsconfig.json \
  --incremental --tsBuildInfoFile "$BUILD_INFO" 2>&1)
if [ $? -ne 0 ]; then
  {
    echo "❌ TypeScript errors in $WORKSPACE_DIR (fix before proceeding):"
    echo "$DIAGNOSTICS" | head -80
  } >&2
  exit 2
fi

exit 0
