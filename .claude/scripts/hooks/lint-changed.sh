#!/usr/bin/env bash
# Runs ESLint on changed files

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.tool_input?.file_path || '')")

# Skip if not a lintable file
if [[ ! "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
  exit 0
fi

echo "🔍 Running ESLint on $FILE_PATH..." >&2

if ! npx eslint "$FILE_PATH" 2>&1; then
  echo "❌ ESLint check failed" >&2
  exit 2
fi

echo "✅ ESLint check passed!" >&2
exit 0
