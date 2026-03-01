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

echo "📘 Type-checking $FILE_PATH" >&2

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
elif [[ "$RELATIVE" =~ ^apps/web/ ]]; then
  WORKSPACE_DIR="apps/web"
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

# Run TypeScript compiler from the workspace directory
if ! (cd "$REPO_ROOT/$WORKSPACE_DIR" && "$TSC_BIN" --noEmit --project tsconfig.json 2>&1); then
  echo "❌ TypeScript compilation failed" >&2
  exit 2
fi

echo "✅ TypeScript check passed!" >&2
exit 0
