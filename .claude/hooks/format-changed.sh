#!/usr/bin/env bash
# PostToolUse hook: auto-format files after Claude writes them.
# Reads tool_input from stdin, extracts file_path, runs prettier.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

# Only format file types Prettier handles
echo "$FILE_PATH" | grep -qE '\.(ts|tsx|js|jsx|mjs|json|css|md|mdx|yml|yaml)$' || exit 0

cd "$(git rev-parse --show-toplevel)"
pnpm exec prettier --write "$FILE_PATH" 2>/dev/null || true
