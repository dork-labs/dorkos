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
  FILE_PATH="${FILE_PATH#$REPO_ROOT/}"
fi

# Detect which workspace the file belongs to and run tsc from there
if [[ "$FILE_PATH" =~ ^apps/server/ ]]; then
  WORKSPACE_DIR="apps/server"
elif [[ "$FILE_PATH" =~ ^apps/client/ ]]; then
  WORKSPACE_DIR="apps/client"
elif [[ "$FILE_PATH" =~ ^apps/obsidian-plugin/ ]]; then
  WORKSPACE_DIR="apps/obsidian-plugin"
elif [[ "$FILE_PATH" =~ ^apps/web/ ]]; then
  WORKSPACE_DIR="apps/web"
elif [[ "$FILE_PATH" =~ ^apps/roadmap/ ]]; then
  WORKSPACE_DIR="apps/roadmap"
elif [[ "$FILE_PATH" =~ ^packages/shared/ ]]; then
  WORKSPACE_DIR="packages/shared"
elif [[ "$FILE_PATH" =~ ^packages/test-utils/ ]]; then
  WORKSPACE_DIR="packages/test-utils"
elif [[ "$FILE_PATH" =~ ^packages/relay/ ]]; then
  WORKSPACE_DIR="packages/relay"
elif [[ "$FILE_PATH" =~ ^packages/mesh/ ]]; then
  WORKSPACE_DIR="packages/mesh"
else
  # Fallback: run from repo root
  WORKSPACE_DIR="."
fi

# Run TypeScript compiler from the workspace directory
if ! npx tsc --noEmit --project "$WORKSPACE_DIR/tsconfig.json" 2>&1; then
  echo "❌ TypeScript compilation failed" >&2
  exit 2
fi

echo "✅ TypeScript check passed!" >&2
exit 0
